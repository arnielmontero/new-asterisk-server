#!/usr/bin/env bash
# Create a timestamped, integrity-checked backup of the stack.
#
# Included:
#   postgres.dump        PostgreSQL (pg_dump custom format: users, audit log)
#   asterisk-config.tar  ./asterisk/config  (dialplan/PJSIP templates; contain no secrets)
#   asterisk-data.tar    Asterisk persistent data volume (AstDB etc.; the regenerated documentation/ is skipped)
#   pki.tar              ./certs (LAN CA + Nginx cert/key) and ./asterisk/keys (DTLS cert/key)  -- PRIVATE KEYS
#   env.file             .env (all passwords and secrets) -- ONLY with --include-env
#   MANIFEST.txt, SHA256SUMS
# Excluded: container logs, Docker images, the contents of ./backups, node_modules/build output.
#
# The archive contains private keys. It is created with mode 600 in a 700 directory. Set
# BACKUP_PASSPHRASE to encrypt it (AES-256, PBKDF2); store the passphrase separately.
#
# Usage: ./scripts/backup.sh [--include-env] [--output-dir DIR]
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."
# Compose project name (default matches docker-compose.yml); override to test a second copy side by side.
PROJECT="${COMPOSE_PROJECT_NAME:-communications-stack}"; export COMPOSE_PROJECT_NAME="$PROJECT"

INCLUDE_ENV=0
OUT_DIR="backups"
while [ $# -gt 0 ]; do
  case "$1" in
    --include-env) INCLUDE_ENV=1 ;;
    --output-dir) OUT_DIR="${2:?--output-dir needs a path}"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die ".env not found"
env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
PGUSER="$(env_value POSTGRES_USER)"; PGDB="$(env_value POSTGRES_DB)"
AST_VOLUME="${PROJECT}_asterisk_data"

docker compose ps --format '{{.Service}} {{.State}}' | grep -q '^database running$' || die "the database service is not running"
docker volume inspect "$AST_VOLUME" >/dev/null 2>&1 || die "volume $AST_VOLUME not found"

umask 077
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
NAME="comms-backup-${STAMP}"
STAGE="$(mktemp -d "${OUT_DIR}/.stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# --- PostgreSQL (consistent snapshot)
log "dumping PostgreSQL"
docker compose exec -T database pg_dump -U "$PGUSER" -d "$PGDB" -Fc --no-owner > "$STAGE/postgres.dump"
[ -s "$STAGE/postgres.dump" ] || die "pg_dump produced an empty file"
USERS="$(docker compose exec -T database psql -U "$PGUSER" -d "$PGDB" -Atc 'SELECT count(*) FROM users' | tr -d '\r')"
AUDITS="$(docker compose exec -T database psql -U "$PGUSER" -d "$PGDB" -Atc 'SELECT count(*) FROM audit_logs' | tr -d '\r')"

# --- Asterisk config, persistent data
log "archiving Asterisk configuration"
tar -cf "$STAGE/asterisk-config.tar" -C asterisk config
log "archiving Asterisk persistent data"
docker run --rm -v "${AST_VOLUME}:/data:ro" alpine:3.20 tar -C /data --exclude=./documentation -cf - . > "$STAGE/asterisk-data.tar"

# --- TLS / DTLS material
log "archiving certificates and keys"
PKI_ITEMS=()
[ -d certs ] && PKI_ITEMS+=(certs)
[ -d asterisk/keys ] && PKI_ITEMS+=(asterisk/keys)
[ "${#PKI_ITEMS[@]}" -gt 0 ] || die "no certs/ or asterisk/keys/ directory to back up"
tar -cf "$STAGE/pki.tar" "${PKI_ITEMS[@]}"

if [ "$INCLUDE_ENV" -eq 1 ]; then
  log "including .env (contains every secret)"
  cp .env "$STAGE/env.file"
fi

# --- manifest + checksums
{
  echo "created_utc=${STAMP}"
  echo "format=1"
  echo "postgres_db=${PGDB}"
  echo "users=${USERS}"
  echo "audit_logs=${AUDITS}"
  echo "includes_env=${INCLUDE_ENV}"
  echo "asterisk_version=$(grep -E '^ARG ASTERISK_VERSION=' asterisk/Dockerfile | cut -d= -f2)"
  echo "host=$(hostname)"
} > "$STAGE/MANIFEST.txt"
( cd "$STAGE" && sha256sum $(ls | grep -v '^SHA256SUMS$') > SHA256SUMS )

# --- pack, then validate what was written
ARCHIVE="${OUT_DIR}/${NAME}.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" .
chmod 600 "$ARCHIVE"

log "validating archive integrity"
gzip -t "$ARCHIVE" || die "gzip integrity check failed"
CHECK="$(mktemp -d "${OUT_DIR}/.verify.XXXXXX")"
trap 'rm -rf "$STAGE" "$CHECK"' EXIT
tar -xzf "$ARCHIVE" -C "$CHECK"
( cd "$CHECK" && sha256sum -c SHA256SUMS >/dev/null ) || die "checksum verification of the archive contents failed"
docker compose exec -T database pg_restore --list < "$CHECK/postgres.dump" > /dev/null || die "the database dump is not readable by pg_restore"
tar -tf "$CHECK/asterisk-config.tar" > /dev/null && tar -tf "$CHECK/asterisk-data.tar" > /dev/null && tar -tf "$CHECK/pki.tar" > /dev/null || die "an inner archive is corrupt"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  log "encrypting archive (AES-256-CBC, PBKDF2)"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$ARCHIVE" -out "${ARCHIVE}.enc"
  chmod 600 "${ARCHIVE}.enc"
  rm -f "$ARCHIVE"
  ARCHIVE="${ARCHIVE}.enc"
fi

SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"
log "OK: ${ARCHIVE} (${SIZE} bytes; ${USERS} users, ${AUDITS} audit records)"
log "this archive contains private keys$([ "$INCLUDE_ENV" -eq 1 ] && echo ' and all secrets'): keep it off shared storage"
echo "$ARCHIVE"
