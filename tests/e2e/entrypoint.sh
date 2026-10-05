#!/bin/sh
set -eu
# Trust the LAN CA the way a user would after installing LAN_CA.crt (acceptance test 5).
mkdir -p "$HOME/.pki/nssdb"
certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n lan-ca -i /certs/LAN_CA.crt
exec node --test --test-timeout=240000 "$@" e2e.test.js
