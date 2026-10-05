#!/usr/bin/env bash
# Run the backend test suite inside a Node container attached to the compose
# network, against the stack's real PostgreSQL service (each test file creates
# and drops its own throw-away database; the application database is untouched).
# Extra arguments are passed to `node --test`, e.g. ./scripts/test-backend.sh tests/auth.test.js
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }

SRC="$(pwd)/backend"
if command -v cygpath >/dev/null 2>&1; then SRC="$(cygpath -m "$SRC")"; fi

NETWORK="$(docker compose config --format json | python3 -c 'import json,sys; print(next(iter(json.load(sys.stdin)["networks"].values()))["name"])' 2>/dev/null || true)"
NETWORK="${NETWORK:-communications-stack_internal}"

docker compose up -d --wait database >/dev/null

ARGS=("${@:-tests/*.test.js}")
docker run --rm --network "$NETWORK" \
  -v "${SRC}:/app" -w /app \
  -e TEST_PG_HOST=database \
  -e TEST_PG_USER="$(env_value POSTGRES_USER)" \
  -e TEST_PG_PASSWORD="$(env_value POSTGRES_PASSWORD)" \
  node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e \
  node --test --test-concurrency=1 "${ARGS[@]}"
