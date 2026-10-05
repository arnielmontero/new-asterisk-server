#!/usr/bin/env bash
# Restore the stack from a backup made by scripts/backup.sh.
#
# Safeguards: the archive path and contents are validated first (integrity, checksums, no
# unexpected or path-escaping entries); a safety backup of the CURRENT state is taken unless
# you pass --no-safety-backup; and nothing is overwritten until you confirm (type "restore",
# or pass --yes for unattended use).
#
# Steps: validate -> safety backup -> stop frontend/backend/asterisk -> restore PostgreSQL ->
#        restore Asterisk config, persistent data, certificates -> fix permissions ->
#        start everything -> health checks.
#
# Usage: ./scripts/restore.sh <backup.tar.gz | backup.tar.gz.enc> [--yes] [--no-safety-backup] [--restore-env]
#   BACKUP_PASSPHRASE must be set for .enc archives.
#   --restore-env  also restore .env when the backup contains it (otherwise the current .env is kept)
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

ARCHIVE=""; ASSUME_YES=0; SAFETY=1; RESTORE_ENV=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=1 ;;
    --no-safety-backup) SAFETY=0 ;;
    --restore-env) RESTORE_ENV=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [ -z "$ARCHIVE" ] && ARCHIVE="$1" || { echo "only one archive may be given" >&2; exit 2; } ;;
  esac
  shift
done

log() { printf '[restore] %s\n' "$*"; }
die() { printf '[restore] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$ARCHIVE" ] || die "usage: restore.sh <backup archive> [--yes]"
[ -f "$ARCHIVE" ] || die "backup file not found: $ARCHIVE"
[ -r "$ARCHIVE" ] || die "backup file is not readable: $ARCHIVE"
[ -f .env ] || die ".env not found (it is needed to reach the database; restore it from your secret store first)"

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
PGUSER="$(env_value POSTGRES_USER)"; PGDB="$(env_value POSTGRES_DB)"
AST_VOLUME="communications-stack_asterisk_data"
HOST="$(env_value SERVER_HOSTNAME)"

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- decrypt if needed
SRC="$ARCHIVE"
case "$ARCHIVE" in
  *.enc)
    [ -n "${BACKUP_PASSPHRASE:-}" ] || die "this archive is encrypted: set BACKUP_PASSPHRASE"
    log "decrypting"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$ARCHIVE" -out "$WORK/archive.tar.gz" 2>/dev/null \
      || die "decryption failed (wrong passphrase or corrupt file)"
    SRC="$WORK/archive.tar.gz"
    ;;
esac

# --- validate before touching anything
log "validating backup"
gzip -t "$SRC" || die "not a valid gzip archive"
BAD="$(tar -tzf "$SRC" | grep -vE '^(\./)?(postgres\.dump|asterisk-config\.tar|asterisk-data\.tar|pki\.tar|env\.file|MANIFEST\.txt|SHA256SUMS|)$' || true)"
[ -z "$BAD" ] || die "archive contains unexpected entries: $(echo "$BAD" | head -n 3 | tr '\n' ' ')"
mkdir -p "$WORK/x"
tar -xzf "$SRC" -C "$WORK/x"
for f in postgres.dump asterisk-config.tar asterisk-data.tar pki.tar MANIFEST.txt SHA256SUMS; do
  [ -f "$WORK/x/$f" ] || die "backup is missing $f"
done
( cd "$WORK/x" && sha256sum -c SHA256SUMS >/dev/null ) || die "checksum verification failed: the backup is corrupt or was modified"
grep -q '^format=1$' "$WORK/x/MANIFEST.txt" || die "unsupported backup format"
for t in asterisk-config.tar asterisk-data.tar pki.tar; do
  # reject absolute paths and ".." in member names
  # capture the listing first: "tar | grep -q" can die of SIGPIPE under pipefail
  members="$(tar -tf "$WORK/x/$t")"
  if printf '%s\n' "$members" | grep -qE '(^/|(^|/)\.\.(/|$))'; then die "$t contains unsafe paths"; fi
done
tar -tf "$WORK/x/asterisk-config.tar" > "$WORK/cfg.list"
grep -q '^config/pjsip.conf$' "$WORK/cfg.list" || die "asterisk-config.tar does not look like this project's config"
tar -tf "$WORK/x/pki.tar" > "$WORK/pki.list"
grep -q 'LAN_CA.crt' "$WORK/pki.list" || die "pki.tar does not contain the LAN CA certificate"
docker compose exec -T database pg_restore --list < "$WORK/x/postgres.dump" >/dev/null || die "the database dump is unreadable"
EXPECT_USERS="$(grep '^users=' "$WORK/x/MANIFEST.txt" | cut -d= -f2)"
log "backup is valid: $(grep '^created_utc=' "$WORK/x/MANIFEST.txt"), ${EXPECT_USERS} users, $(grep '^audit_logs=' "$WORK/x/MANIFEST.txt" | cut -d= -f2) audit records"

docker compose ps --format '{{.Service}} {{.State}}' | grep -q '^database running$' || die "the database service must be running (docker compose up -d database)"

# --- confirmation
if [ "$ASSUME_YES" -ne 1 ]; then
  echo
  echo "This REPLACES the live database, Asterisk configuration and persistent data, and the TLS/DTLS keys"
  echo "with the contents of: $ARCHIVE"
  printf 'Type "restore" to continue: '
  read -r answer
  [ "$answer" = "restore" ] || die "aborted; nothing was changed"
fi

# --- safety backup of the current state
if [ "$SAFETY" -eq 1 ]; then
  log "taking a safety backup of the current state first"
  SAFE="$(./scripts/backup.sh --output-dir backups/pre-restore | tail -n 1)" || die "safety backup failed; aborting before any change"
  log "safety backup: $SAFE"
fi

# --- stop the services that use the data (database stays up)
log "stopping frontend, backend and asterisk"
docker compose stop frontend backend asterisk >/dev/null

# --- PostgreSQL
log "restoring PostgreSQL"
docker compose exec -T database pg_restore -U "$PGUSER" -d "$PGDB" --clean --if-exists --no-owner --single-transaction < "$WORK/x/postgres.dump" \
  || die "pg_restore failed (the previous database state is unchanged: restore runs in one transaction)"

# --- Asterisk configuration (replaces files from the backup; others are left alone)
log "restoring Asterisk configuration"
tar -xf "$WORK/x/asterisk-config.tar" -C asterisk

# --- certificates and keys
log "restoring certificates and keys"
tar -xf "$WORK/x/pki.tar"
find certs asterisk/keys -name '*.key' -exec chmod 600 {} + 2>/dev/null || true
find certs asterisk/keys \( -name '*.crt' -o -name '*.pem' \) -exec chmod 644 {} + 2>/dev/null || true
chmod 600 asterisk/keys/asterisk_dtls.key 2>/dev/null || true

# --- Asterisk persistent data volume
log "restoring Asterisk persistent data"
docker run --rm -i -v "${AST_VOLUME}:/data" alpine:3.20 sh -c 'find /data -mindepth 1 -maxdepth 1 ! -name documentation -exec rm -rf {} + && tar -C /data -xf - && chown -R 10001:10001 /data' < "$WORK/x/asterisk-data.tar" \
  || die "restoring the Asterisk data volume failed"

if [ "$RESTORE_ENV" -eq 1 ]; then
  if [ -f "$WORK/x/env.file" ]; then
    cp .env ".env.before-restore" && cp "$WORK/x/env.file" .env && chmod 600 .env
    log "restored .env (previous one kept as .env.before-restore)"
  else
    log "this backup does not contain .env; keeping the current one"
  fi
fi

# --- verify permissions
for k in certs/LAN_CA.key certs/nginx.key asterisk/keys/asterisk_dtls.key; do
  [ -f "$k" ] || continue
  mode="$(stat -c %a "$k" 2>/dev/null || stat -f %Lp "$k")"
  [ "$mode" = "600" ] || log "WARNING: $k has mode $mode (expected 600; NTFS/Windows hosts cannot enforce this)"
done

# --- restart and health-check
log "starting the stack"
docker compose up -d >/dev/null
log "waiting for the services to become healthy"
deadline=$(( $(date +%s) + 150 ))
while :; do
  unhealthy="$(docker compose ps --format '{{.Service}} {{.Health}}' | grep -v ' healthy$' || true)"
  [ -z "$unhealthy" ] && break
  [ "$(date +%s)" -lt "$deadline" ] || die "services did not become healthy: $unhealthy"
  sleep 3
done
CURL=(curl -sS --max-time 15 --ssl-no-revoke --cacert certs/LAN_CA.crt --resolve "${HOST}:443:127.0.0.1")
for _ in $(seq 1 30); do
  health="$("${CURL[@]}" "https://${HOST}/api/health" 2>/dev/null || true)"
  printf '%s' "$health" | grep -q '"status":"ok"' && break
  sleep 2
done
printf '%s' "$health" | grep -q '"status":"ok"' || die "backend /health is not ok after the restore: $health"
USERS_NOW="$(docker compose exec -T database psql -U "$PGUSER" -d "$PGDB" -Atc 'SELECT count(*) FROM users' | tr -d '\r')"
[ "$USERS_NOW" = "$EXPECT_USERS" ] || die "user count after restore ($USERS_NOW) does not match the backup ($EXPECT_USERS)"
# (no "-o /dev/null": the Windows curl build returns exit 23 for it)
code="$("${CURL[@]}" -w '
%{http_code}' "https://${HOST}/" | tail -n 1)"
[ "$code" = "200" ] || die "frontend returned HTTP $code after the restore"

log "OK: restore complete. database users=${USERS_NOW}, /health ok, frontend serving."
