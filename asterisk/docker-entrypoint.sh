#!/bin/sh
# Render Asterisk config templates with secrets from the environment into a
# private runtime directory, install key material with correct ownership, then
# drop privileges and run Asterisk in the foreground.
set -eu

TEMPLATE_DIR=/etc/asterisk
RUN_DIR=/run/asterisk
ETC_DIR="${RUN_DIR}/etc"
KEY_DIR="${RUN_DIR}/keys"

VARS='EXT_1001_PASSWORD EXT_1002_PASSWORD EXT_1001_PHONE_PASSWORD EXT_1002_PHONE_PASSWORD AMI_USER AMI_PASS AMI_PORT AMI_PERMIT SERVER_IP SERVER_HOSTNAME LAN_SUBNET PROXY_PERMIT RTP_START RTP_END'

fail() { echo "asterisk-entrypoint: $*" >&2; exit 1; }

# Required variables must be present and non-empty.
for v in $VARS; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || fail "required environment variable $v is not set"
done

# Secrets are written into Asterisk config where ; # and $ are special, so
# restrict the character set and enforce a minimum length.
for v in EXT_1001_PASSWORD EXT_1002_PASSWORD EXT_1001_PHONE_PASSWORD EXT_1002_PHONE_PASSWORD AMI_PASS; do
  eval "val=\${$v}"
  printf '%s' "$val" | grep -Eq '^[A-Za-z0-9._~+=-]{16,}$' \
    || fail "$v must be at least 16 characters from [A-Za-z0-9._~+=-]"
done
printf '%s' "$AMI_USER" | grep -Eq '^[A-Za-z0-9_-]{1,32}$' || fail "AMI_USER has invalid characters"
printf '%s' "$AMI_PORT" | grep -Eq '^[0-9]{2,5}$' || fail "AMI_PORT must be numeric"
printf '%s' "$RTP_START" | grep -Eq '^[0-9]{4,5}$' || fail "RTP_START must be numeric"
printf '%s' "$RTP_END" | grep -Eq '^[0-9]{4,5}$' || fail "RTP_END must be numeric"
for v in AMI_PERMIT LAN_SUBNET PROXY_PERMIT; do
  eval "val=\${$v}"
  printf '%s' "$val" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' \
    || fail "$v must be an IPv4 CIDR such as 192.168.0.0/16"
done

[ -d "$TEMPLATE_DIR" ] || fail "config directory $TEMPLATE_DIR missing"

rm -rf "$ETC_DIR" "$KEY_DIR"
mkdir -p "$ETC_DIR" "$KEY_DIR"

ENVSUBST_LIST=""
for v in $VARS; do ENVSUBST_LIST="${ENVSUBST_LIST} \${$v}"; done

for tpl in "$TEMPLATE_DIR"/*.conf; do
  [ -e "$tpl" ] || fail "no *.conf templates found in $TEMPLATE_DIR"
  envsubst "$ENVSUBST_LIST" < "$tpl" > "$ETC_DIR/$(basename "$tpl")"
done

# Optional modules treat a missing config file as an error. Provide an empty
# file (defaults apply) for every one this stack loads but does not configure.
for name in acl agents aeap ccss cel chan_websocket codecs features geolocation hep \
            parking pjproject pjsip_notify pjsip_wizard res_http_media_cache \
            res_stun_monitor smdi statsd stasis udptl websocket_client; do
  [ -e "$ETC_DIR/${name}.conf" ] || : > "$ETC_DIR/${name}.conf"
done

# Fail early if a placeholder was left unrendered.
if grep -E '\$\{(EXT_|AMI_|SERVER_|LAN_|PROXY_|RTP_)' "$ETC_DIR"/*.conf >/dev/null 2>&1; then
  fail "unrendered placeholder left in generated config"
fi

# Key material: copy the bind-mounted keys so the unprivileged user can read
# them regardless of host-side ownership.
for f in asterisk_dtls.pem asterisk_dtls.key; do
  [ -s "$TEMPLATE_DIR/keys/$f" ] \
    || fail "$TEMPLATE_DIR/keys/$f missing - run scripts/generate-certs.sh first"
  cp "$TEMPLATE_DIR/keys/$f" "$KEY_DIR/$f"
done

# Persistent /var/lib/asterisk hides the image's copy; refresh the XML docs so
# upgrades (and third-party module docs such as Opus) are always present.
rm -rf /var/lib/asterisk/documentation
cp -a /usr/share/asterisk-documentation /var/lib/asterisk/documentation

chown -R asterisk:asterisk "$RUN_DIR" /var/lib/asterisk /var/log/asterisk /var/spool/asterisk
chmod 0700 "$ETC_DIR" "$KEY_DIR"
chmod 0600 "$ETC_DIR"/*.conf "$KEY_DIR"/*

echo "asterisk-entrypoint: starting $(asterisk -V)"
exec setpriv --reuid=asterisk --regid=asterisk --init-groups \
  /usr/sbin/asterisk -f -C "$ETC_DIR/asterisk.conf"
