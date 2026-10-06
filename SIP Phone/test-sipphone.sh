#!/usr/bin/env bash
# Runs the SIP phone engine's end-to-end self-test against the running stack.
#
# Two phone clients (1001-phone and 1002-phone) register with the real Asterisk and are driven through calls,
# audio, DTMF, hold, decline, invalid numbers and one-way paging (authorised through the real backend API).
# The microphone and speaker are replaced by tones, so no sound card is needed.
#
# The test runs in a Linux container with host networking, next to Asterisk, because on Docker Desktop for
# Windows Asterisk's host network is inside the Docker VM and the Windows host cannot send SIP to it.
# On a Linux server you can run the same test (or the Windows .exe itself) from any LAN PC.
#
# Usage: ./test-sipphone.sh [-v]        (-v prints the SIP messages)
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
[ -f .env ] || { echo "No .env found in $ROOT" >&2; exit 2; }

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
OUT="$HERE/artifacts/selftest-linux"
echo "[sipphone-test] publishing the self-test for linux-x64"
rm -rf "$OUT"
mkdir -p "$HERE/artifacts"
# (no >/dev/null: MSBuild fails under Git Bash when stdout is /dev/null)
if ! dotnet publish "$(winpath "$HERE/src/SipPhone.SelfTest/SipPhone.SelfTest.csproj")" -c Release -r linux-x64 --self-contained \
  -p:InvariantGlobalization=true -o "$(winpath "$OUT")" --nologo -v q > "$HERE/artifacts/publish.log" 2>&1; then
  cat "$HERE/artifacts/publish.log" >&2; echo "[sipphone-test] publish failed" >&2; exit 2
fi

# Address of the PBX as the phone would be configured: the host's LAN IP. On Docker Desktop that is the VM's
# address inside LAN_SUBNET; override with PBX_HOST on a real server.
PBX_HOST="${PBX_HOST:-$(docker run --rm --network host python:3.12-slim sh -c \
  "awk '/32 host LOCAL/ {print prev} {prev=\$2}' /proc/net/fib_trie | grep '^192\.168\.65\.' | head -n1" 2>/dev/null || true)}"
PBX_HOST="${PBX_HOST:-$(env_value SERVER_IP)}"
echo "[sipphone-test] PBX address: $PBX_HOST"

CA_MOUNT="$(winpath "$ROOT/certs")"
OUT_MOUNT="$(winpath "$OUT")"
HOSTNAME_FOR_TLS="$(env_value SERVER_HOSTNAME)"

docker run --rm --network host \
  -v "$OUT_MOUNT:/test:ro" -v "$CA_MOUNT:/certs:ro" \
  -e DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
  -e PBX_HOST="$PBX_HOST" -e PBX_PORT=5060 \
  -e PHONE1_USER=1001-phone -e PHONE1_PASS="$(env_value EXT_1001_PHONE_PASSWORD)" \
  -e PHONE2_USER=1002-phone -e PHONE2_PASS="$(env_value EXT_1002_PHONE_PASSWORD)" \
  -e API_ADDR=127.0.0.1 -e API_HOST="${HOSTNAME_FOR_TLS:-communications.local}" -e API_CA=/certs/LAN_CA.crt \
  -e STOP_AFTER="${STOP_AFTER:-}" -e QUICK="${QUICK:-}" -e ADMIN_USER=admin -e ADMIN_PASS="$(env_value ADMIN_PASSWORD)" \
  python:3.12-slim /test/SipPhone.SelfTest "$@"
