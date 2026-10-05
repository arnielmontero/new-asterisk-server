#!/usr/bin/env bash
# Runtime validation of the running stack (spec section 60). Every check exercises the real
# services; nothing here is mocked. Exits non-zero if any check fails.
#
#   ./scripts/test-stack.sh            run everything, including restarting Asterisk and the database
#   ./scripts/test-stack.sh --quick    skip the restart checks (no service interruption)
#
# Needs: docker compose, curl and a generated .env + certificates. JSON is parsed with the
# backend container's Node, so nothing else has to be installed on the host.
set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
cd "$(dirname "$0")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

[ -f .env ] || { echo ".env not found (run scripts/init-env.sh)" >&2; exit 2; }

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
HOST="$(env_value SERVER_HOSTNAME)"
ADMIN_PW="$(env_value ADMIN_PASSWORD)"
ASTERISK_VERSION="$(grep -E '^ARG ASTERISK_VERSION=' asterisk/Dockerfile | cut -d= -f2)"
AST="communications-stack-asterisk-1"
CURL=(curl -sS --max-time 15 --ssl-no-revoke --cacert certs/LAN_CA.crt --resolve "${HOST}:443:127.0.0.1")
API="https://${HOST}/api"

PASS=0; FAIL=0; FAILED=()
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n        %s\n' "$1" "${2:-}"; }
check() { # check "name" <command...> : passes when the command succeeds
  local name="$1"; shift
  local out; out="$("$@" 2>&1)" && ok "$name" || bad "$name" "$(printf '%s' "$out" | tail -n 3)"
}
section() { printf '\n== %s\n' "$1"; }
ast() { docker exec "$AST" asterisk -C /run/asterisk/etc/asterisk.conf -rx "$1" 2>/dev/null; }
# json '<JS expression over d>' : reads JSON on stdin, prints the expression's value
json() { docker compose exec -T backend node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const d=JSON.parse(b);console.log(eval(process.argv[1]))})' "$1" | tr -d ''; }

TOKEN=""
login() { # login <user> <pw> -> token on stdout
  "${CURL[@]}" -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | json 'd.token||""' 2>/dev/null
}
status_of() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }

# ------------------------------------------------------------------ 1-3
section "Docker Compose"
check "docker compose config validates" docker compose config -q
for svc in asterisk backend database frontend; do
  running="$(docker compose ps --format '{{.Service}} {{.State}}' | grep -E "^${svc} running$" || true)"
  [ -n "$running" ] && ok "service $svc is running" || bad "service $svc is running" "$(docker compose ps "$svc" 2>&1 | tail -n 2)"
done
for svc in asterisk backend database frontend; do
  health="$(docker compose ps --format '{{.Service}} {{.Health}}' | grep -E "^${svc} " | awk '{print $2}')"
  [ "$health" = "healthy" ] && ok "container $svc is healthy" || bad "container $svc is healthy" "health=$health"
done

# ------------------------------------------------------------------ 4-6
section "HTTPS, backend, database"
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://${HOST}/" 2>/dev/null)"
[ "$code" = "200" ] && ok "HTTPS serves the app (certificate verified against the LAN CA)" || bad "HTTPS serves the app" "HTTP $code"
health="$("${CURL[@]}" "$API/health")"
[ "$(printf '%s' "$health" | json 'd.status+"/"+d.checks.database+"/"+d.checks.ami')" = "ok/ok/connected" ] \
  && ok "backend /health reports ok (database ok, AMI connected)" || bad "backend /health reports ok" "$health"
check "PostgreSQL accepts connections (pg_isready)" docker compose exec -T database sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
published="$(docker compose ps --format '{{.Service}} {{.Publishers}}' | grep -E '^(database|backend) ' | grep -E '0\.0\.0\.0|\[::\]' || true)"
[ -z "$published" ] && ok "database and backend ports are not published to the host" || bad "database/backend must not publish ports" "$published"

# ------------------------------------------------------------------ 7
section "AMI connectivity"
banner="$(docker compose exec -T backend sh -c 'node -e "const s=require(\"net\").connect(+process.env.AMI_PORT,process.env.AMI_HOST);s.once(\"data\",d=>{console.log(String(d).trim());process.exit(0)});s.on(\"error\",e=>{console.log(e.message);process.exit(1)})"' 2>&1)"
printf '%s' "$banner" | grep -q 'Asterisk Call Manager' && ok "backend container reaches AMI ($banner)" || bad "backend container reaches AMI" "$banner"

# ------------------------------------------------------------------ 8-10
section "Authentication, RBAC and audit"
TOKEN="$(login admin "$ADMIN_PW")"
[ -n "$TOKEN" ] && ok "administrator login returns a JWT" || bad "administrator login returns a JWT"
[ "$(status_of -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong-password-xyz"}')" = "401" ] \
  && ok "invalid login is rejected (401)" || bad "invalid login is rejected (401)"
[ "$(status_of "$API/extensions")" = "401" ] && ok "unauthenticated API call is rejected (401)" || bad "unauthenticated API call is rejected (401)"
AUTH=(-H "Authorization: Bearer $TOKEN")

TS="ts$(date +%s)"
mk() { "${CURL[@]}" -X POST "$API/users" "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"Stack-Test-Passw0rd-$TS\",\"role\":\"$2\"}" | json 'd.user.id' 2>/dev/null; }
OP_ID="$(mk "$TS.op" operator)"; US_ID="$(mk "$TS.user" user)"
[ -n "$OP_ID" ] && [ -n "$US_ID" ] && ok "administrator can create users (operator, user)" || bad "administrator can create users"
OP_T="$(login "$TS.op" "Stack-Test-Passw0rd-$TS")"; US_T="$(login "$TS.user" "Stack-Test-Passw0rd-$TS")"
g() { status_of "$@"; }
[ "$(g "$API/users" -H "Authorization: Bearer $US_T")" = "403" ] && ok "RBAC: user role cannot list users (403)" || bad "RBAC: user role cannot list users"
[ "$(g -X POST "$API/page" -H "Authorization: Bearer $US_T" -H 'Content-Type: application/json' -d '{"group":"700"}')" = "403" ] && ok "RBAC: user role cannot page (403)" || bad "RBAC: user role cannot page"
[ "$(g -X POST "$API/originate" -H "Authorization: Bearer $US_T" -H 'Content-Type: application/json' -d '{"from":"1001","to":"1002"}')" = "403" ] && ok "RBAC: user role cannot originate (403)" || bad "RBAC: user role cannot originate"
[ "$(g "$API/users" -H "Authorization: Bearer $OP_T")" = "403" ] && ok "RBAC: operator cannot manage users (403)" || bad "RBAC: operator cannot manage users"
[ "$(g "$API/audit" -H "Authorization: Bearer $OP_T")" = "403" ] && ok "RBAC: operator cannot read the audit log (403)" || bad "RBAC: operator cannot read the audit log"
[ "$(g "$API/extensions" -H "Authorization: Bearer $US_T")" = "200" ] && ok "RBAC: user role can read extension status (200)" || bad "RBAC: user role can read extension status"
[ "$(g -X POST "$API/originate" -H "Authorization: Bearer $OP_T" -H 'Content-Type: application/json' -d '{"from":"1001","to":"9999"}')" = "400" ] && ok "invalid originate destination rejected (400)" || bad "invalid originate destination rejected"
[ "$(g -X POST "$API/page" -H "Authorization: Bearer $OP_T" -H 'Content-Type: application/json' -d '{"group":"799"}')" = "400" ] && ok "invalid paging group rejected (400)" || bad "invalid paging group rejected"
audit="$("${CURL[@]}" "$API/audit?pageSize=200" "${AUTH[@]}")"
for a in "auth.login:success" "auth.login:failure" "user.create:success"; do
  n="$(printf '%s' "$audit" | json "d.items.filter(r=>r.action==='${a%%:*}'&&r.status==='${a##*:}').length")"
  [ "${n:-0}" -ge 1 ] && ok "audit log has ${a%%:*} (${a##*:}) records" || bad "audit log has ${a%%:*} (${a##*:}) records"
done
for id in "$OP_ID" "$US_ID"; do [ -n "$id" ] && "${CURL[@]}" -o /dev/null -X DELETE "$API/users/$id" "${AUTH[@]}"; done

# ------------------------------------------------------------------ 11-14
section "Asterisk"
ver="$(ast 'core show version')"
printf '%s' "$ver" | grep -q "Asterisk ${ASTERISK_VERSION} " && ok "Asterisk version is the pinned ${ASTERISK_VERSION}" || bad "Asterisk version is the pinned ${ASTERISK_VERSION}" "$ver"
eps="$(ast 'pjsip show endpoints')"
for e in 1001 1002 1001-phone 1002-phone; do
  printf '%s' "$eps" | grep -qE "Endpoint: +${e}(/| )" && ok "PJSIP endpoint $e is configured" || bad "PJSIP endpoint $e is configured"
done
tr="$(ast 'pjsip show transports')"
printf '%s' "$tr" | grep -q 'transport-udp' && printf '%s' "$tr" | grep -q 'transport-ws' && ok "PJSIP UDP and WebSocket transports are up" || bad "PJSIP UDP and WebSocket transports are up" "$tr"
dp="$(ast 'dialplan show 700@default')"
printf '%s' "$dp" | grep -q 'sub-page' && ok "dialplan 700@default routes to the paging subroutine" || bad "dialplan 700@default routes to the paging subroutine" "$dp"
for m in app_page app_confbridge app_echo app_dial chan_pjsip res_http_websocket res_pjsip_transport_websocket res_srtp codec_opus codec_ulaw codec_alaw; do
  ast "module show like $m" | grep -qE "^${m}\.so +.*Running" && ok "module $m is loaded" || bad "module $m is loaded"
done
http="$(ast 'http show status')"
printf '%s' "$http" | grep -q 'Bound to 0.0.0.0:8088' && printf '%s' "$http" | grep -q '/ws' && ok "Asterisk HTTP/WS server listens on 8088 and serves /ws" || bad "Asterisk HTTP/WS server listens on 8088 and serves /ws" "$http"
up="$("${CURL[@]}" -i --max-time 4 --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' -H 'Sec-WebSocket-Protocol: sip' "https://${HOST}/ws" 2>&1 | head -n 8)"
printf '%s' "$up" | grep -q '101 Switching Protocols' && printf '%s' "$up" | grep -qi 'Sec-WebSocket-Protocol: sip' && ok "wss://${HOST}/ws upgrades through Nginx to Asterisk (101, subprotocol sip)" || bad "wss upgrade through Nginx to Asterisk" "$up"
[ "$(ast 'dtls' >/dev/null; docker exec "$AST" sh -c 'stat -c %U:%a /run/asterisk/keys/asterisk_dtls.key')" = "asterisk:600" ] && ok "DTLS private key is owned by asterisk with mode 600" || bad "DTLS private key ownership/mode"
proc="$(docker exec "$AST" sh -c 'for d in /proc/[0-9]*; do [ "$(cat $d/comm 2>/dev/null)" = asterisk ] && stat -c %U $d && break; done')"
[ -n "$proc" ] && [ "$proc" != "root" ] && ok "Asterisk daemon does not run as root (user $proc)" || bad "Asterisk daemon does not run as root" "user=$proc"

# ------------------------------------------------------------------ 17
section "Frontend"
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "https://${HOST}/app.js" 2>/dev/null)"
[ "$code" = "200" ] && ok "frontend bundle is served" || bad "frontend bundle is served" "HTTP $code"
hdr="$("${CURL[@]}" -I "https://${HOST}/")"
for h in 'content-security-policy' 'x-content-type-options: nosniff' 'x-frame-options' 'referrer-policy' 'permissions-policy'; do
  printf '%s' "$hdr" | grep -qi "$h" && ok "security header present: $h" || bad "security header present: $h"
done

# ------------------------------------------------------------------ 15-16 (+ persistence)
if [ "$QUICK" -eq 1 ]; then
  section "Restart checks"
  echo "  (skipped: --quick)"
else
  section "Asterisk restart: the backend must reconnect AMI within 10 s of AMI coming back"
  docker compose restart asterisk >/dev/null 2>&1
  # when does AMI start accepting connections?
  t_ami=""; for _ in $(seq 1 120); do
    if docker exec "$AST" bash -c 'exec 3<>/dev/tcp/127.0.0.1/5038 && head -c 22 <&3' 2>/dev/null | grep -q 'Asterisk Call Manager'; then t_ami="$(date +%s.%N)"; break; fi
    sleep 0.25
  done
  [ -n "$t_ami" ] || bad "Asterisk AMI came back after restart"
  t_ok=""; for _ in $(seq 1 120); do
    if "${CURL[@]}" "$API/health" 2>/dev/null | grep -q '"ami":"connected"'; then t_ok="$(date +%s.%N)"; break; fi
    sleep 0.25
  done
  if [ -n "$t_ami" ] && [ -n "$t_ok" ]; then
    delta="$(awk "BEGIN{printf \"%.1f\", $t_ok-$t_ami}")"
    awk "BEGIN{exit !($delta <= 10)}" && ok "backend reconnected to AMI ${delta}s after AMI came back (limit 10 s)" || bad "backend AMI reconnect within 10 s" "took ${delta}s"
  else
    bad "backend reconnected to AMI after Asterisk restart" "AMI up at='${t_ami}' backend connected at='${t_ok}'"
  fi
  sleep 3
  health="$("${CURL[@]}" "$API/health")"
  [ "$(printf '%s' "$health" | json 'd.status')" = "ok" ] && ok "/health is ok again after the restart" || bad "/health is ok again after the restart" "$health"
  st="$("${CURL[@]}" "$API/system/status" "${AUTH[@]}" | json 'd.ami.state')"
  [ "$st" = "connected" ] && ok "admin status reports AMI connected" || bad "admin status reports AMI connected" "$st"

  section "PostgreSQL persistence across a restart"
  before="$("${CURL[@]}" "$API/users" "${AUTH[@]}" | json 'd.users.length')"
  docker compose restart database >/dev/null 2>&1
  for _ in $(seq 1 60); do docker compose exec -T database sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && break; sleep 1; done
  sleep 3
  TOKEN2="$(login admin "$ADMIN_PW")"
  after="$("${CURL[@]}" "$API/users" -H "Authorization: Bearer $TOKEN2" | json 'd.users.length')"
  [ -n "$TOKEN2" ] && [ "$before" = "$after" ] && ok "users survive a database restart ($after users, admin can still log in)" || bad "users survive a database restart" "before=$before after=$after"
  [ "$(status_of "$API/health")" = "200" ] && ok "backend recovered from the database restart" || bad "backend recovered from the database restart"
fi

# ------------------------------------------------------------------ summary
printf '\n== Summary: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf 'Failed checks:\n'; printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
exit 0
