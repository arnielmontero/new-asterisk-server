#!/usr/bin/env bash
# End-to-end test of scripts/backup.sh and scripts/restore.sh against the running stack, using
# marker data: a user created BEFORE the backup must exist after the restore, a user created
# AFTER the backup must be gone. Also proves that a tampered archive is rejected untouched.
#
# This restarts frontend/backend/asterisk (restore) - run it on a development or test stack.
# Usage: ./scripts/test-backup-restore.sh
set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
HOST="$(env_value SERVER_HOSTNAME)"; ADMIN_PW="$(env_value ADMIN_PASSWORD)"
PGUSER="$(env_value POSTGRES_USER)"; PGDB="$(env_value POSTGRES_DB)"
CURL=(curl -sS --max-time 20 --ssl-no-revoke --cacert certs/LAN_CA.crt --resolve "${HOST}:443:127.0.0.1")
API="https://${HOST}/api"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n        %s\n' "$1" "${2:-}"; }
sql() { docker compose exec -T database psql -U "$PGUSER" -d "$PGDB" -Atc "$1" | tr -d '\r'; }
login() { "${CURL[@]}" -X POST "$API/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
mkuser() { "${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$API/users" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$1\",\"password\":\"Backup-Test-Passw0rd-$STAMP\",\"role\":\"user\"}" 2>/dev/null; }
exists() { [ "$(sql "SELECT count(*) FROM users WHERE username='$1'")" = "1" ]; }

STAMP="$(date +%s)"; BEFORE="bk.before.$STAMP"; AFTER="bk.after.$STAMP"
TOKEN="$(login)"; [ -n "$TOKEN" ] || { echo "cannot log in as admin" >&2; exit 2; }

echo "== Backup"
[ "$(mkuser "$BEFORE")" = "201" ] && ok "marker user created before the backup" || bad "marker user created before the backup"
AUDIT_BEFORE="$(sql 'SELECT count(*) FROM audit_logs')"
ARCHIVE="$(./scripts/backup.sh --output-dir backups/test | tail -n 1)"
[ -f "$ARCHIVE" ] && ok "backup archive created: $ARCHIVE" || { bad "backup archive created" "$ARCHIVE"; exit 1; }
# NTFS (Windows hosts) cannot enforce POSIX modes: detect that first and report it instead of failing.
PROBE="backups/test/.modeprobe"; : > "$PROBE"; chmod 640 "$PROBE"
if [ "$(stat -c %a "$PROBE" 2>/dev/null)" = "640" ]; then
  [ "$(stat -c %a "$ARCHIVE" 2>/dev/null)" = "600" ] && ok "archive mode is 600" || bad "archive mode is 600" "$(stat -c %a "$ARCHIVE" 2>/dev/null)"
else
  printf '  NOTE  file modes are not enforceable on this filesystem; archive mode 600 NOT VERIFIED here
'
fi
rm -f "$PROBE"
LISTING="$(tar -tzf "$ARCHIVE")"
case "$LISTING" in *env.file*) bad "archive must not contain .env by default" ;; *) ok "archive does not contain .env by default" ;; esac
case "$LISTING" in *postgres.dump*) ok "archive contains the database dump" ;; *) bad "archive contains the database dump" "$LISTING" ;; esac

echo "== Damage the live state after the backup"
[ "$(mkuser "$AFTER")" = "201" ] && ok "second marker user created after the backup" || bad "second marker user created after the backup"
exists "$AFTER" && ok "second marker is present before the restore" || bad "second marker is present before the restore"

echo "== Tampered archive is rejected and nothing changes"
BAD="backups/test/tampered.tar.gz"; cp "$ARCHIVE" "$BAD"
printf 'X' | dd of="$BAD" bs=1 seek=200 conv=notrunc 2>/dev/null
if ./scripts/restore.sh "$BAD" --yes --no-safety-backup >/tmp/restore-tamper.log 2>&1; then bad "tampered archive must be rejected" "restore succeeded"; else ok "tampered archive rejected ($(grep -m1 -E 'ERROR' /tmp/restore-tamper.log | cut -c1-90))"; fi
exists "$AFTER" && ok "live data untouched by the rejected restore" || bad "live data untouched by the rejected restore"
rm -f "$BAD"

echo "== Restore"
if ./scripts/restore.sh "$ARCHIVE" --yes >/tmp/restore.log 2>&1; then ok "restore completed ($(tail -n 1 /tmp/restore.log | cut -c1-110))"; else bad "restore completed" "$(tail -n 5 /tmp/restore.log)"; fi
exists "$BEFORE" && ok "user created before the backup is back" || bad "user created before the backup is back"
exists "$AFTER" && bad "user created after the backup must be gone" || ok "user created after the backup is gone"
[ "$(sql 'SELECT count(*) FROM audit_logs')" -ge "$AUDIT_BEFORE" ] && ok "audit log restored (not shorter than at backup time)" || bad "audit log restored"
TOKEN="$(login)"; [ -n "$TOKEN" ] && ok "administrator can log in after the restore" || bad "administrator can log in after the restore"
"${CURL[@]}" "$API/health" | grep -q '"status":"ok"' && ok "/health ok after the restore" || bad "/health ok after the restore"
[ -n "$(ls backups/pre-restore/*.tar.gz 2>/dev/null)" ] && ok "a safety backup of the pre-restore state was taken" || bad "a safety backup of the pre-restore state was taken"
for _ in $(seq 1 20); do docker exec communications-stack-asterisk-1 asterisk -C /run/asterisk/etc/asterisk.conf -rx 'core show version' 2>/dev/null | grep -q 'Asterisk 22' && break; sleep 2; done
docker exec communications-stack-asterisk-1 asterisk -C /run/asterisk/etc/asterisk.conf -rx 'dialplan show 700@default' 2>/dev/null | grep -q sub-page && ok "Asterisk is up with the paging dialplan after the restore" || bad "Asterisk is up with the paging dialplan after the restore"

# clean up the markers and test archives
TOKEN="$(login)"
for u in "$BEFORE"; do id="$(sql "SELECT id FROM users WHERE username='$u'")"; [ -n "$id" ] && "${CURL[@]}" -o /dev/null -X DELETE "$API/users/$id" -H "Authorization: Bearer $TOKEN" 2>/dev/null; done
rm -rf backups/test backups/pre-restore

printf '\n== Summary: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
