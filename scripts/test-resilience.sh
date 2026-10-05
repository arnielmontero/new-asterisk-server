#!/usr/bin/env bash
# Resilience test with REAL outages: stops and restarts the backend and Asterisk containers while
# real Chromium browsers (tests/e2e/resilience.test.js) watch what the user sees. The browser side
# runs in a container on the compose network; this script performs the outages and tells the
# browsers when each one is in place (files in a shared directory).
#
# Interrupts the stack for about a minute each time: run it on a development or test stack.
# Usage: ./scripts/test-resilience.sh
set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
HOSTNAME_="$(env_value SERVER_HOSTNAME)"
NETWORK="communications-stack_internal"
FRONTEND_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${NETWORK}\").IPAddress}}" communications-stack-frontend-1)"
[ -n "$FRONTEND_IP" ] || { echo "frontend container is not running" >&2; exit 1; }

SYNC="$(pwd)/backups/.sync-$$"
mkdir -p "$SYNC"
SYNC_MOUNT="$SYNC"; CERT="$(pwd)/certs/LAN_CA.crt"
if command -v cygpath >/dev/null 2>&1; then SYNC_MOUNT="$(cygpath -m "$SYNC")"; CERT="$(cygpath -m "$CERT")"; fi

CID=""
cleanup() {
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1
  rm -rf "$SYNC"
  # whatever happened, leave the stack running
  docker compose start backend asterisk >/dev/null 2>&1
}
trap cleanup EXIT

log() { printf '[resilience] %s\n' "$*"; }
wait_healthy() { # wait_healthy <service> <seconds>
  local end=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ "$(docker compose ps "$1" --format '{{.Health}}')" = healthy ] && return 0
    sleep 2
  done
  return 1
}
wait_ready() { # wait_ready <step> : block until the browser side is in place (or the test container died)
  while [ ! -f "$SYNC/$1.ready" ]; do
    [ "$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null)" = true ] || { log "test container stopped before step $1"; return 1; }
    sleep 1
  done
}

START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker build -q -t comms-e2e tests/e2e >/dev/null
# Docker Desktop occasionally answers "EOF" to a container create: retry a few times.
for attempt in 1 2 3; do
  CID="$(docker run -d --network "$NETWORK" --add-host "${HOSTNAME_}:${FRONTEND_IP}" --ipc=host \
  -v "${CERT}:/certs/LAN_CA.crt:ro" -v "${SYNC_MOUNT}:/sync" \
  -e BASE_URL="https://${HOSTNAME_}" -e ADMIN_PASSWORD="$(env_value ADMIN_PASSWORD)" \
  -e TEST_FILE=resilience.test.js -e TEST_TIMEOUT=600000 comms-e2e)" && [ -n "$CID" ] && break
  CID=""; log "container create failed (attempt $attempt), retrying"; sleep 3
done
[ -n "$CID" ] || { log "could not start the test container"; exit 1; }

wait_ready backend-down || exit 1
log "stopping the backend"; docker compose stop backend >/dev/null 2>&1; touch "$SYNC/backend-down.go"

wait_ready backend-up || exit 1
log "holding the outage for 15 s"; sleep 15
log "starting the backend"; docker compose start backend >/dev/null 2>&1
wait_healthy backend 90 || log "WARNING: backend did not become healthy"
touch "$SYNC/backend-up.go"

wait_ready ami-down || exit 1
log "stopping Asterisk"; docker compose stop asterisk >/dev/null 2>&1; touch "$SYNC/ami-down.go"

wait_ready ami-up || exit 1
log "holding the outage for 15 s"; sleep 15
log "starting Asterisk"; docker compose start asterisk >/dev/null 2>&1
wait_healthy asterisk 120 || log "WARNING: asterisk did not become healthy"
touch "$SYNC/ami-up.go"

docker wait "$CID" >/dev/null 2>&1
docker logs "$CID" 2>&1 | grep -vE '^\s*$' | grep -E '✔|✖|^ℹ (tests|pass|fail)|Error|expected|actual|at ' | head -60
CODE="$(docker inspect -f '{{.State.ExitCode}}' "$CID")"

# The backend must also have shut down gracefully while browsers were connected (no forced exit).
BLOGS="$(docker compose logs backend --no-log-prefix --since "$START_TS" 2>&1)"
if printf '%s' "$BLOGS" | grep -q 'shutdown complete' && ! printf '%s' "$BLOGS" | grep -q 'forced exit'; then
  log "backend shut down gracefully with browsers connected"
else
  log "FAILED: backend did not shut down gracefully (no 'shutdown complete' or a forced exit was logged)"; CODE=1
fi
[ "$CODE" = "0" ] && log "all resilience checks passed" || log "FAILED (exit $CODE)"
exit "$CODE"
