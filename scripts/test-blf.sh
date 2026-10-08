#!/usr/bin/env bash
# Busy-lamp (BLF) check with a minimal SIP phone: registers 1001-phone and 1002-phone, subscribes 1001-phone to the state of
# extension 1002 (what the lamp key of a desk phone does), makes Asterisk ring 1002-phone, and expects the lamp to go
# idle -> ringing -> idle. The probe runs in a host-network container because Asterisk only accepts phones from LAN_SUBNET:
# it adds a throw-away address from that subnet to the loopback device of that container.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."
PROJECT="${COMPOSE_PROJECT_NAME:-communications-stack}"; export COMPOSE_PROJECT_NAME="$PROJECT"
env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }

BASE="https://127.0.0.1"
LAN="$(env_value LAN_SUBNET)"; SRC="${LAN%.*}.77"
TOKEN="$(curl -sk -H 'Content-Type: application/json' -X POST "$BASE/api/auth/login" -d "{\"username\":\"admin\",\"password\":\"$(env_value ADMIN_PASSWORD)\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')"
phone_password() { curl -sk -H "Authorization: Bearer $TOKEN" "$BASE/api/pbx/extensions/$1/credentials" | sed 's/.*"phone":{[^}]*"password":"\([^"]*\)".*/\1/'; }
CREDS="{\"1001\":\"$(phone_password 1)\",\"1002\":\"$(phone_password 2)\"}"

DIR="$(pwd)/tests/blf"
if command -v cygpath >/dev/null 2>&1; then DIR="$(cygpath -m "$DIR")"; fi
OUT="$(mktemp)"
docker run --rm --network host --cap-add NET_ADMIN -v "$DIR:/s:ro" -e SRC_IP="$SRC" -e SIP_DOMAIN="$(env_value SERVER_HOSTNAME)" -e CREDS="$CREDS" \
  node:22-alpine sh -c "ip addr add $SRC/32 dev lo 2>/dev/null || true; node /s/blf.js; rc=\$?; ip addr del $SRC/32 dev lo 2>/dev/null || true; exit \$rc" > "$OUT" 2>&1 &
PID=$!
sleep 8
docker exec "${PROJECT}-asterisk-1" asterisk -C /run/asterisk/etc/asterisk.conf -rx "channel originate PJSIP/1002-phone application Wait 5" >/dev/null
sleep 3
# The probe never answers; hang up just that ringing channel so the lamp can go idle again.
CHAN="$(docker exec "${PROJECT}-asterisk-1" asterisk -C /run/asterisk/etc/asterisk.conf -rx "core show channels concise" | cut -d'!' -f1 | grep '^PJSIP/1002-phone-' | head -n1 || true)"
[ -n "$CHAN" ] && docker exec "${PROJECT}-asterisk-1" asterisk -C /run/asterisk/etc/asterisk.conf -rx "channel request hangup $CHAN" >/dev/null
wait "$PID" || true
cat "$OUT"
grep -q '^PASS$' "$OUT"
