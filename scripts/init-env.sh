#!/usr/bin/env bash
# Create .env from .env.example with random secrets. Refuses to overwrite.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -e .env ]; then
  echo "init-env: .env already exists; refusing to overwrite it." >&2
  exit 1
fi

rand() { openssl rand -hex "$1"; }

declare -A secrets=(
  [POSTGRES_PASSWORD]="$(rand 16)"
  [JWT_SECRET]="$(rand 32)"
  [ADMIN_PASSWORD]="$(rand 12)"
  [AMI_PASS]="$(rand 16)"
  [EXT_1001_PASSWORD]="$(rand 16)"
  [EXT_1002_PASSWORD]="$(rand 16)"
  [EXT_1001_PHONE_PASSWORD]="$(rand 16)"
  [EXT_1002_PHONE_PASSWORD]="$(rand 16)"
)

cp .env.example .env
for key in "${!secrets[@]}"; do
  sed -i "s|^${key}=.*|${key}=${secrets[$key]}|" .env
done
chmod 600 .env

echo "init-env: wrote .env with generated secrets."
echo "init-env: edit SERVER_IP, SERVER_HOSTNAME and LAN_SUBNET for your network before generating certificates."
