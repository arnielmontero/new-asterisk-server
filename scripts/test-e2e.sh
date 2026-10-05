#!/usr/bin/env bash
# Real-browser end-to-end tests (Chromium via Playwright) against the running stack.
# Needs: the stack up and healthy, certificates generated, and a Docker network that
# can reach the frontend container. Extra args are passed to `node --test`.
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
HOSTNAME_="$(env_value SERVER_HOSTNAME)"
NETWORK="communications-stack_internal"

FRONTEND_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${NETWORK}\").IPAddress}}" communications-stack-frontend-1)"
[ -n "$FRONTEND_IP" ] || { echo "frontend container is not running" >&2; exit 1; }

CERT="$(pwd)/certs/LAN_CA.crt"
if command -v cygpath >/dev/null 2>&1; then CERT="$(cygpath -m "$CERT")"; fi

docker build -q -t comms-e2e tests/e2e >/dev/null

docker run --rm --network "$NETWORK" \
  --add-host "${HOSTNAME_}:${FRONTEND_IP}" \
  --ipc=host \
  -v "${CERT}:/certs/LAN_CA.crt:ro" \
  -e BASE_URL="https://${HOSTNAME_}" \
  -e ADMIN_PASSWORD="$(env_value ADMIN_PASSWORD)" \
  comms-e2e "$@"
