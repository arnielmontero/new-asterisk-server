#!/bin/sh
# Healthy only if the daemon answers on its control socket AND the subsystems
# the stack depends on are actually up (PJSIP UDP transport, HTTP/WS server, AMI).
set -eu

CONF=/run/asterisk/etc/asterisk.conf
cli() { asterisk -C "$CONF" -rx "$1"; }

cli "core show uptime seconds" | grep -Eq '^System uptime: [0-9]+' || exit 1
cli "pjsip show transports" | grep -q 'transport-udp' || exit 1
cli "http show status" | grep -q 'Server Enabled and Bound to' || exit 1
cli "manager show settings" | grep -Eq 'Manager \(AMI\):[[:space:]]+Yes' || exit 1
exit 0
