#!/usr/bin/env bash
# Generate the LAN PKI:
#   certs/LAN_CA.crt, certs/LAN_CA.key         local certificate authority
#   certs/nginx.crt,  certs/nginx.key          HTTPS/WSS server cert signed by the CA
#   asterisk/keys/asterisk_dtls.pem, .key      dedicated Asterisk DTLS-SRTP cert/key
#
# SANs come from SERVER_IP and SERVER_HOSTNAME (environment or .env).
# Refuses to overwrite existing material unless --force is given.
set -euo pipefail

# Git Bash on Windows rewrites arguments starting with "/" (e.g. -subj /CN=...).
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# Work from the repo root with relative paths: native Windows openssl cannot
# resolve MSYS-style /c/... absolute paths once path conversion is disabled.
cd "$(dirname "$0")/.."
CERT_DIR="certs"
AST_KEY_DIR="asterisk/keys"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Read a single KEY=value from .env without sourcing it.
env_value() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

SERVER_IP="${SERVER_IP:-$(env_value SERVER_IP)}"
SERVER_HOSTNAME="${SERVER_HOSTNAME:-$(env_value SERVER_HOSTNAME)}"

[ -n "$SERVER_IP" ] || { echo "SERVER_IP is not set (environment or .env)" >&2; exit 1; }
[ -n "$SERVER_HOSTNAME" ] || { echo "SERVER_HOSTNAME is not set (environment or .env)" >&2; exit 1; }

if ! printf '%s' "$SERVER_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  echo "SERVER_IP is not a valid IPv4 address: $SERVER_IP" >&2; exit 1
fi
if ! printf '%s' "$SERVER_HOSTNAME" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'; then
  echo "SERVER_HOSTNAME is not a valid hostname: $SERVER_HOSTNAME" >&2; exit 1
fi

command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }

CA_KEY="${CERT_DIR}/LAN_CA.key"
CA_CRT="${CERT_DIR}/LAN_CA.crt"
NGX_KEY="${CERT_DIR}/nginx.key"
NGX_CRT="${CERT_DIR}/nginx.crt"
AST_CRT="${AST_KEY_DIR}/asterisk_dtls.pem"
AST_KEY="${AST_KEY_DIR}/asterisk_dtls.key"

existing=()
for f in "$CA_KEY" "$CA_CRT" "$NGX_KEY" "$NGX_CRT" "$AST_CRT" "$AST_KEY"; do
  [ -e "$f" ] && existing+=("$f")
done
if [ "${#existing[@]}" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  echo "Refusing to overwrite existing certificate material:" >&2
  printf '  %s\n' "${existing[@]}" >&2
  echo "Re-run with --force to regenerate everything (clients must then re-trust the new CA)." >&2
  exit 1
fi

mkdir -p "$CERT_DIR" "$AST_KEY_DIR"
umask 077
WORK="${CERT_DIR}/.work.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

# ----------------------------------------------------------------- LAN CA
openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 3650 \
  -subj "/O=LAN Communications/CN=LAN Communications Root CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" \
  -out "$CA_CRT"

# ------------------------------------------------------------ Nginx server
openssl genrsa -out "$NGX_KEY" 2048 2>/dev/null
openssl req -new -key "$NGX_KEY" -subj "/O=LAN Communications/CN=${SERVER_HOSTNAME}" \
  -out "${WORK}/nginx.csr"

cat > "${WORK}/nginx.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
subjectAltName=DNS:${SERVER_HOSTNAME},IP:${SERVER_IP}
EOF

# 825 days is the longest server certificate lifetime accepted by Apple platforms.
openssl x509 -req -in "${WORK}/nginx.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" \
  -CAcreateserial -CAserial "${WORK}/ca.srl" -sha256 -days 825 \
  -extfile "${WORK}/nginx.ext" -out "$NGX_CRT" 2>/dev/null

# ------------------------------------------- Asterisk DTLS-SRTP (separate key)
# Self-signed: peers authenticate it by SDP fingerprint (dtls_verify=fingerprint),
# not by CA chain. PEM certificate + unencrypted PEM private key, as Asterisk's
# dtls_cert_file / dtls_private_key options expect.
openssl genrsa -out "$AST_KEY" 2048 2>/dev/null
openssl req -x509 -new -key "$AST_KEY" -sha256 -days 3650 \
  -subj "/O=LAN Communications/CN=asterisk-dtls.${SERVER_HOSTNAME}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth,clientAuth" \
  -out "$AST_CRT"

# ------------------------------------------------------------- permissions
chmod 600 "$CA_KEY" "$NGX_KEY" "$AST_KEY"
chmod 644 "$CA_CRT" "$NGX_CRT" "$AST_CRT"

# ------------------------------------------------------------- self-checks
openssl verify -CAfile "$CA_CRT" "$NGX_CRT" >/dev/null
san="$(openssl x509 -in "$NGX_CRT" -noout -ext subjectAltName)"
printf '%s' "$san" | grep -q "DNS:${SERVER_HOSTNAME}" || { echo "SAN check failed (DNS)" >&2; exit 1; }
printf '%s' "$san" | grep -q "IP Address:${SERVER_IP}" || { echo "SAN check failed (IP)" >&2; exit 1; }
[ "$(openssl x509 -in "$AST_CRT" -noout -pubkey | openssl sha256)" = \
  "$(openssl pkey -in "$AST_KEY" -pubout | openssl sha256)" ] \
  || { echo "Asterisk DTLS cert/key mismatch" >&2; exit 1; }

echo "Generated:"
echo "  CA certificate (install on clients): ${CA_CRT}"
echo "  Nginx certificate/key:               ${NGX_CRT} / ${NGX_KEY}"
echo "  Asterisk DTLS certificate/key:       ${AST_CRT} / ${AST_KEY}"
echo "  Nginx SANs: DNS:${SERVER_HOSTNAME}, IP:${SERVER_IP}"
echo "Private keys are mode 600 and git-ignored. Never commit or share *.key files."
