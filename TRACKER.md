# LAN Communications & Intercom Stack — Build Tracker

Source spec: [task.md](task.md) (section numbers below, e.g. `§33`, refer to it).
Update this file as work lands. Status is only moved to `PASS` after the behavior was **actually run and observed** (spec §74 — no fake success).

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done and verified · `MANUAL REQUIRED` needs hardware/human · `BLOCKED` cannot proceed (reason noted)

**Last updated:** 2026-10-05 (all three phases complete; the only open items are the MANUAL REQUIRED hardware / real-LAN tests)

---

## Progress summary

| Phase | Scope | Spec priority steps (§78) | Done | Status |
|-------|-------|---------------------------|------|--------|
| 1 | Foundation & Telephony Core | 1–4 | 27 / 27 | Verified |
| 2 | Application: Backend, Frontend, Calls & Paging | 5–11 | 38 / 38 | Verified: 143 backend + 9 frontend unit tests, 18 browser E2E, 6 resilience |
| 3 | Hardening, Validation & Delivery | 12–17 | 23 / 24 (+1 partial) | Done except firewall behaviour on a real LAN (MANUAL REQUIRED); physical phone, other browsers/OS and listening check are MANUAL REQUIRED |
| | **Total** | | **88 / 89** (+1 partial) | Acceptance: 29 PASS, 1 MANUAL REQUIRED (test 30); see COMPLETION_REPORT.md |

Phase gate rule (§78): do not start the next phase while the previous phase's exit criteria are failing.

---

## Phase 1 — Foundation & Telephony Core

Goal: a running, pinned Asterisk 22 LTS container that accepts SIP (UDP) and WebRTC (WS) registrations for 1001/1002 and answers the echo test, with TLS material generated.

### 1.1 Repository & Docker foundation (§54, §55, §70)
- [x] Project structure — `asterisk/`, `scripts/` exist; `backend/` and `frontend/` are created in Phase 2
- [x] `.gitignore` (env, keys, certs, dumps, logs, node_modules) + `.gitattributes` (LF for scripts/configs)
- [x] `.env.example` with all variables from §55 (+ RTP range, LAN subnet, proxy ACL, phone passwords); `scripts/init-env.sh` generates a `.env` with random secrets
- [x] `docker-compose.yml`: 4 services, `restart: unless-stopped`, healthchecks, pinned images, `host-gateway` mapping — asterisk + database run and are healthy; backend/frontend are defined but untested until Phase 2
- [x] `docker compose config` validates

### 1.2 Asterisk exact pinned build (§7, §8)
- [x] Exact version **22.11.0**, source SHA256 verified in the Dockerfile (matches upstream `asterisk-22-current.sha256`)
- [x] Debian 12.12-slim pinned by digest; Opus codec binary pinned by version + SHA256. Debian apt packages are not version-pinned (no snapshot repo) — known limitation
- [x] Builds with PJSIP, res_http_websocket, SRTP/DTLS, Opus (transcoding), Page(), Echo(), Dial(), ConfBridge
- [x] Runs the daemon as uid 10001 (entrypoint starts as root only to render config, then `setpriv` drops privileges); host networking; mounts per §7 (config `:ro`, keys, data volume, logs volume)
- [x] Healthcheck (uptime + PJSIP UDP transport + HTTP server + AMI) reports healthy; negative case verified: freezing the Asterisk daemon (SIGSTOP) turned the container `unhealthy` after ~68 s and it recovered to `healthy` within 15 s of resuming
- [x] Runtime check: all required modules `Running` (chan_pjsip, res_pjsip*, res_http_websocket, res_pjsip_transport_websocket, res_srtp, res_rtp_asterisk, app_page, app_confbridge, app_echo, app_dial, codec_opus/ulaw/alaw)

### 1.3 Base Asterisk config (§9–§12, §25–§26)
- [x] `asterisk.conf`, `modules.conf`, `logger.conf` (startup log clean: only the benign "no music on hold" warning remains)
- [x] `http.conf` — plain WS on `0.0.0.0:8088`; `http show status` lists `/ws`
- [x] `rtp.conf` — explicit range 10100–10300, strict RTP, ICE
- [x] `manager.conf` — dedicated AMI user, least privilege (read `system,call`; write `system,call,command,originate`), ACL
- [x] Config templating: secrets come from env, rendered into `/run/asterisk/etc` at start (never written to the host)

### 1.4 PJSIP transports & endpoints (§10, §11, §43)
- [x] UDP transport :5060; WebSocket transport
- [x] No anonymous endpoint / no guest access; per-endpoint LAN/proxy ACL
- [x] Endpoints 1001 (Office) / 1002 (Warehouse) — WebRTC profile; `pjsip show endpoint` confirms webrtc, DTLS (fingerprint, actpass), ICE, AVPF, rtcp-mux, opus/ulaw/alaw
- [x] Physical phone profile (UDP, ulaw/alaw, no encryption) as `1001-phone` / `1002-phone`

### 1.5 Basic dialplan (§33, §41)
- [x] 1001 ↔ 1002 direct dial, 30 s timeout — dialplan loaded and inspected; calls between two registered clients are tested in Phase 2
- [x] 600 Echo test (Answer / Echo / Hangup) — verified with a real SIP client (see exit criteria)

### 1.6 Certificates (§12, §15, §53) — script only; hardening in Phase 3
- [x] `scripts/generate-certs.sh`: LAN CA, Nginx cert (SANs from `SERVER_IP`/`SERVER_HOSTNAME`), separate Asterisk DTLS cert/key; self-checks (chain, SANs, key match) pass; refuses to overwrite without `--force`

### Phase 1 exit criteria
- [x] Asterisk container `healthy`; `core show version` → Asterisk 22.11.0
- [x] `pjsip show transports` lists UDP + WS; `pjsip show endpoints` lists 1001, 1002, 1001-phone, 1002-phone
- [x] `http show status` shows `/ws` on 8088; DTLS cert/key load without error at startup — an actual DTLS handshake needs a browser (Phase 2/3)
- [x] Real SIP client (baresip, UDP) registered as `1001-phone`, called 600, and the received audio was the 440 Hz tone it sent (RMS 8491, tone/off-tone power ratio ≈ 1e9, ~64 kbit/s RTP both ways). Wrong password and unknown user were rejected; AMI login works from a permitted network, fails with wrong credentials, and is refused from a non-permitted source

---

## Phase 2 — Application: Backend, Frontend, Calls & Paging

Goal: authenticated dashboard with real-time extension state, softphone, normal calls, and live one-way paging with browser auto-answer.

### 2.1 Backend core — PostgreSQL / auth / RBAC (§17–§24, §46, §49–§50)
- [x] Express app, modular layout (auth, users, extensions, paging, calls, audit, ami, database, socket, health, validation, system)
- [x] DB connection with retry; versioned, checksummed, advisory-locked idempotent migrations (tested: fresh DB, re-run, concurrent start, tamper detection, rollback)
- [x] `users` + `audit_logs` tables, indexes, FKs; audit table is append-only enforced by PostgreSQL triggers
- [x] Admin bootstrap from `ADMIN_PASSWORD` (idempotent, never overwrites, value never logged — verified: none of the 8 secrets appear in any container log)
- [x] `POST /api/auth/login` — bcrypt cost 12, JWT HS256 with issuer/audience/expiry, per-IP+username rate limit, HttpOnly SameSite=Strict cookie (documented in README in 3.6)
- [x] RBAC middleware (admin / operator / user) enforced server-side; role read from DB per request, so demotion/deactivation is immediate
- [x] User CRUD `GET/POST/PATCH/DELETE /api/users` + last-admin protection (incl. concurrent-demotion race)
- [x] Input validation (zod, strict schemas), 10 kB body limit, safe errors (no stack traces)
- [x] Structured logging (pino) with secret redaction
- [x] Audit logging for every event in §32 (login ok/fail, user create/update/delete, originate, paging request/success/failure/end/cancel, bootstrap)

### 2.2 AMI integration & real-time state (§25, §27–§29, §58, §69)
- [x] AMI client: auth, events, ActionID correlation, ping-based dead-link detection, exponential backoff (reset on success), state exposed — unit-tested against a mock AMI server (drop, outage, half-open link, bad credentials, stop)
- [x] Extension state derived from real AMI events (ContactStatus, DeviceStateChange, DialEnd, Newchannel, Hangup, dialplan UserEvents) plus a sync on connect
- [x] Normalized states: Online / Offline / In-Call / Paging (and "Unknown" while AMI is down — never guessed)
- [x] Socket.IO with authenticated connections (cookie, bearer or handshake token); events documented in `src/socket/index.js`
- [x] `GET /health` reflects DB **and** AMI honestly (200 only when both healthy; 503 degraded/down otherwise); `/health/live` is liveness only
- [x] Graceful shutdown (HTTP, Socket.IO, AMI, DB) — verified: SIGTERM → "shutdown complete" in the container logs

### 2.3 Frontend SPA & softphone (§35–§40, §65, §67–§68)
- [x] SIP.js pinned to exactly 0.21.2 (plus socket.io-client 4.8.4, esbuild 0.28.2; lockfiles committed)
- [x] Login page; first-use "Enable microphone and audio" gate (secure-context check, mic-denied and no-mic messages)
- [x] Dashboard: 1001/1002 live state, call/hang-up, paging buttons (role-aware); read-only role verified in a real browser
- [x] Softphone: register (WSS), call, incoming answer/reject/hang-up, mute, call state, echo test — verified in Chromium
- [x] SIP registration state shown separately from dashboard login (header chip + softphone panel)
- [x] User management, audit log and system status pages exercised in a real browser (create / weak password refused / duplicate refused / edit role + disable / disabled account cannot log in / delete / last admin protected / audit filters + pager / system cards)
- [x] Error handling per §67 exercised in real browsers: login failure, call rejected, paging failure, unauthorised direct page, microphone denied/missing/busy/refused, audio-blocked banner + recovery, backend-unreachable banner (real backend stop), AMI-disconnected banner and Unknown state (real Asterisk stop), automatic recovery of both
- [x] Nginx: HTTPS (TLS 1.2/1.3), HTTP→HTTPS 301, `/api`, `/socket.io`, `/ws` proxy, security headers (CSP, nosniff, frame, referrer, permissions-policy), `ASTERISK_HOST` templating, lazy backend resolution

### 2.4 Normal calling (§30)
- [x] `POST /api/originate` — strict validation, configured extensions only, fixed AMI action, audited (incl. async result); `POST /api/hangup`
- [x] Browser 1001 ↔ 1002 manual-answer two-way calls — verified in both directions by measuring decoded audio tones

### 2.5 Paging (§4, §5, §31, §33–§35)
- [x] Audio-source architecture: dashboard → backend authorises + audits (single-use AstDB grant) → operator's browser places the SIP call with its microphone → dialplan checks the grant → `Page()`
- [x] `POST /api/page` (700/701/702 only), concurrency guard (one page at a time), audit, 20 s grant expiry, admin force-end
- [x] Version-correct `Page()` dialplan (22.11.0) with `b()` pre-dial handler setting headers via `PJSIP_HEADER()` and the caller identity via `CONNECTEDLINE()`
- [x] Outgoing INVITE carries `X-Paging-Call: true`, `Call-Info: <sip:host>;answer-after=0`, `P-Asserted-Identity`, From `Paging <sip:700@…>` — captured both in Asterisk's SIP trace and as received by the browser over WSS
- [x] Self-page prevention (initiator excluded from targets; paging a group you are the only member of is refused 422)
- [x] Browser auto-answer gated on **all** conditions (known group + `X-Paging-Call` exactly `true` + `answer-after=0`); unit-tested exhaustively and verified: ordinary calls still ring
- [x] One-way audio verified by measurement: recipient hears the operator, operator hears nothing back (with RTP flowing)
- [x] `paging.started` / `paging.ended` / `paging.failed` events reach the dashboard; dead-media timeout (30 s) and 5-minute page cap stop stuck pages

### Phase 2 exit criteria
- [x] Backend test suite green: 143 tests (auth, RBAC, users, calls, paging, DB, health, AMI client, state, Socket.IO)
- [x] Browser registers as 1001 and 1002 over WSS and is accepted by Asterisk
- [x] INVITE headers for paging captured from a real SIP trace
- [x] Browser E2E suite (15 tests) passes: 15 consecutive full runs, 225/225 tests, 0 failures after the RTP-port fix (see Decisions & open items)

---

## Phase 3 — Hardening, Validation & Delivery

Goal: secure, backed-up, tested, documented, and honestly verified end to end.

### 3.1 Physical phone compatibility (§42, §66)
- [x] Physical SIP phone profile + docs (DEPLOYMENT.md section 9, TESTING.md M1)
- [x] Hardware tests recorded as `MANUAL REQUIRED` with exact steps (acceptance test 30; TESTING.md M1-M4). They have NOT been run: no phone is available

### 3.2 TLS / PKI / security hardening (§15, §16, §43, §45–§48)
- [x] Generated certs verified: Nginx cert chains to the LAN CA (`openssl verify` OK) with SANs DNS:communications.local + the server IP, CA has `CA:TRUE, pathlen:0`, the Asterisk DTLS certificate is a separate self-signed pair, re-running the script leaves everything unchanged (hashes identical), keys/certs are git-ignored and absent from history. Mode 600 cannot be verified on this NTFS host (checked inside the container: asterisk:600)
- [x] CSP / security headers don't break mic/WebRTC
- [~] Firewall rules documented (LAN-only; AMI, 8088, Postgres not exposed) — documented in DEPLOYMENT.md; the nftables ruleset and DOCKER-USER rules were loaded successfully in a throwaway network namespace (syntax and kernel acceptance), but their effect on a real LAN is NOT verified (MANUAL REQUIRED, TESTING.md M3)
- [x] CORS same-origin; no wildcard — no `Access-Control-*` header is ever sent; a cross-origin POST is refused with 403 `bad_origin`; a preflight from a foreign origin gets no CORS grant
- [x] Secrets scan: every secret value in .env was searched for in the tracked files, the full git history and all container logs (none found); no bearer tokens, cookies or test passwords in logs; no private key in history; `.env`, `certs/`, `asterisk/keys/*`, `backups/` are git-ignored

### 3.3 Backup & restore (§51–§52)
- [x] `scripts/backup.sh` (timestamped, secure perms, integrity check)
- [x] `scripts/restore.sh` (path validation, safeguards, health check after)
- [x] Backup and restore actually run on a test environment

### 3.4 Automated tests (§59–§60)
- [x] Backend: auth, RBAC, users, calls, paging, DB, health, AMI reconnect
- [x] Asterisk config tests: endpoints, dialplan, modules, transports
- [x] `scripts/test-stack.sh` covering all 17 checks in §60, non-zero exit on failure

### 3.5 Runtime / telephony acceptance (§61–§64, §75)
- [x] Real SIP signaling capture proves paging headers (§62)
- [x] Audio verified where possible (RTP packet/audio inspection); else `MANUAL REQUIRED` with exact steps
- [x] One-way paging verified behaviorally (§64)
- [x] Normal calls confirmed not auto-answering
- [x] Logs reviewed; errors fixed; failed tests repeated — all four services reviewed; every remaining warning/error is caused by a test that deliberately triggers it (duplicate keys, append-only checks, outages). Fixed from the review: forced backend exit on shutdown while browsers are connected, Asterisk music-on-hold warning

### 3.6 Documentation (§71–§72)
- [x] `README.md` (architecture, requirements, install, JWT handling, pinned versions)
- [x] `DEPLOYMENT.md` (certs, DNS/hosts, firewall, browser + phone setup, backup/restore)
- [x] `TESTING.md` (procedures, MANUAL REQUIRED steps)
- [x] Troubleshooting + known browser/phone limitations
- [x] Final completion report (§77): [COMPLETION_REPORT.md](COMPLETION_REPORT.md)

### Phase 3 exit criteria
- [x] All 30 acceptance tests below are `PASS` or `MANUAL REQUIRED` — none unverified, none silently skipped

---

## Extension programme — full-featured PBX (requested 2026-10-06)

The original build was fixed to two extensions (1001/1002) with no trunks, no outside numbers and no call history. The
programme below turns it into a managed PBX. Delivered in phases; each phase is built, tested against the live stack and only then
marked done.

### Phase A — Managed extensions, trunks, routes, call history (done 2026-10-06)
- [x] Database-managed extensions (3-6 digits), browser + phone logins, generated secrets, outbound permission, caller ID, per-extension credentials view (audited) and secret regeneration
- [x] Paging groups with arbitrary members (700/701/702 seeded); paging, state tracking and click-to-call work for any extension
- [x] SIP trunks: registration (provider), IP-authenticated (provider / other PBX / GSM-FXO gateway), UDP/TCP, codecs, DTMF mode, channel limit, caller ID, default inbound destination; live status from Asterisk (registered/rejected, reachable, active calls)
- [x] Inbound routes (DID exact, `+`, Asterisk pattern, `*` catch-all; per trunk or all trunks; caller-name prefix; destinations: extension, echo, reject/busy/congestion)
- [x] Outbound routes (patterns, strip/prepend, ordered trunk failover, caller ID, emergency routes, route order = priority via per-route contexts). Extensions are not allowed to dial out unless enabled
- [x] Config pipeline: PostgreSQL -> strict whitelist renderer -> files in a volume shared with Asterisk -> AMI reload; debounced, serialised, checksum-skipping, catches up when AMI reconnects, failure surfaced in the UI (System page, header chip) and the audit log
- [x] Call history (Asterisk CDR over AMI -> PostgreSQL): list with filters and paging, statistics (per day, per hour, busiest numbers), CSV export (formula-safe), retention (`CDR_RETENTION_DAYS`)
- [x] Admin UI: Extensions, Trunks, Routes, Call history pages; Users page uses the live extension list; dashboard dial box accepts outside numbers; System page shows trunks and apply status
- [x] **Verified:** 222 backend tests (up from 143); 9 browser tests building everything through the UI and placing a real call out through a trunk and back in with a measured echo tone (`tests/e2e/admin-pbx.test.js`); the original 18 browser tests, 57 stack checks, 16 backup/restore, 6 resilience and 48 Windows-phone end-to-end checks all still pass
- Defects found by testing: chained `validate()` middlewares dropped route params (500s); two outbound routes with the same pattern silently shadowed each other (fixed with per-route contexts included in order); trunk "unavailable" state wrongly skipped usable trunks; a new trunk could take a minute to show ONLINE (now qualified immediately); inline `style` attributes violate the CSP (charts use the CSS object model)

### Phase B — call flow (in progress)
#### B1 — ring groups, time conditions, forwarding, do not disturb (done 2026-10-06)
- [x] One destination model for everything that routes a call (extension, ring group, time condition, echo, reject); one dialplan context per destination; hop counter against loops; deleting something that is still used is refused and lists the users
- [x] Ring groups (ring all / sequential, per-member order, fallback), time conditions (open periods per day, holidays, time zone, manual override), per-extension DND and forward all / busy / no answer, self-service on the dashboard
- [x] Reload only what changed (a dialplan-only change never touches PJSIP); trunk status read from the endpoint list (a trunk now shows ONLINE in seconds); two trunks cannot share an address
- [x] **Verified:** 244 backend tests; 10 real-browser scenarios (`tests/e2e/callflow.test.js`: DND, forwarding, ring-all, sequential, DND skipping, time condition via an inbound trunk call with overrides and a holiday); earlier browser suites re-run
- Defects found by testing: CDR destination became `s` after a Goto into a destination context (the dialled number is now kept); `PJSIPShowContacts` answers "No Contacts found" for trunks, which wiped trunk reachability; two IP trunks with the same address made inbound calls land in the wrong trunk's routes
#### B2 — audio prompts, announcements, IVR menus (done 2026-10-06)
- [x] Prompt library (WAV any rate/format -> 8 kHz mono, server side in pure JS; MP3/M4A/OGG and microphone recordings converted in the browser), preview, rename, delete-protection while in use; shared `pbx_media` volume; Nginx allows the large body on the upload URL only
- [x] Announcements (play then continue/hang up) and IVR menus (keys 0-9 * #, timeout, repeats, fall-back, optional direct extension dialling, self-return allowed, loops cut by the hop counter); both are destinations everywhere; new softphone keypad (DTMF)
- [x] **Verified:** 264 backend tests (WAV formats incl. 8/16/24/32-bit and float, hostile names, oversized uploads, orphan files, number-space sharing, reference protection, dialplan-only reload); 10 real-browser scenarios (`tests/e2e/ivr.test.js`) with measured prompt tones, DTMF routing and fall-back timing
#### B3 — call queues with agents (done 2026-10-06)
- [x] Queues: six strategies, agent ring/rest time, maximum wait and callers, fall-back destination, refuse-when-empty; `app_queue` enabled with generated `queues_generated.conf` (reloaded on its own, ahead of the dialplan); members are Local channels that ring the extension's browser and phone (DND skipped) and watch a combined device-state hint
- [x] Live status (QueueStatus), agent pause/resume (QueuePause), statistics from real queue events (served, abandoned, turned away, wait, talk, service level, per agent); dashboard "My queues" panel
- [x] **Verified:** 279 backend tests; 9 real-browser scenarios (`tests/e2e/queues.test.js`)
- Defects found by testing: Asterisk reports a timed-out caller as an abandon before our dialplan reports the real reason (the reason now replaces it); `queue reload all` does not reorder existing members, and penalties do not escalate on a timeout, so an in-order queue whose agent order changes is reloaded without the queue first and then with it
#### B4 — voicemail and call recording (done 2026-10-08)
- [x] Voicemail per extension (on/off, greeting from the prompt library, longest message): callers who get no answer, busy / do not disturb or no reachable client leave a message after a beep; a forward setting still wins; a voicemail box is also a destination of its own (routes, menus, forwarding). Messages are recorded by the dialplan to the shared media volume and reported with a UserEvent; the backend checks the report against the file before listing it (forged names, other people's files, empty or non-audio files and hang-ups during the greeting create nothing). Owners hear, mark and delete their messages on the dashboard (live update over the socket, playback is never cut off by a refresh); administrators see every box
- [x] Call recording per extension (either end) and per trunk: MixMonitor on the answering side, only while bridged, once per call however many sides qualify; ended by the channel's hang-up and measured once the file stops growing; call history shows a "Play recording" button; administrators list, play, download and delete recordings (all audited). Retention: `RECORDING_RETENTION_DAYS`, `VOICEMAIL_RETENTION_DAYS`
- [x] **Verified:** 308 backend tests (up from 279); 9 real-browser scenarios (`tests/e2e/voicemail.test.js`): messages left with no one logged in, with do-not-disturb and after the ring time, arriving live on an open dashboard; the downloaded message and recordings are measured to contain sound; one recording when both ends record; callee-only recording; a loop-back trunk with recording in both directions; nothing recorded when switched off
- Not done: message-waiting lamps on physical phones (needs an MWI subscription / notify template); listening to voicemail by phone (no Asterisk sound files are installed, so there are no spoken menus); only the web dashboard plays messages
- Defects found by testing: `CHANNEL(endpoint)` exists only on PJSIP channels (the extension is now read from the channel name); `Record()` fails without a beep sound file (option `q`, a generated tone is the beep); Asterisk does not reliably send `MixMonitorStop` for a recording that ends with the call, so the channel's `Hangup` ends it; refreshing the voicemail list on "heard" removed the player and cut the sound off

### Phase C — Conferencing, parking, transfer, presence (in progress)
#### C1 — conference rooms (done 2026-10-08)
- [x] Rooms (3-6 digit number, name, optional PIN, optional administrator PIN, mute on entry, member limit, enabled); dial the number from anywhere, or use a room as a destination of inbound routes, menus, schedules and forwarding. PINs are asked for after a tone (no Asterisk sound files are installed), compared in the dialplan, three tries; the administrator PIN joins with admin rights; options are applied per call with a channel profile (a profile named in `ConfBridge()` would have ignored them)
- [x] Live room state from Asterisk (who is in each room, extension recognised, admin / muted / talking); mute, unmute, remove and lock / unlock from the Conferences page, each only for someone in the room right now; phone keys 1 mute yourself, 2 lock, 3 remove the last person (admin); dashboard lists the rooms with a Join button. All changes audited, PINs never
- [x] **Verified:** 322 backend tests; 7 real-browser scenarios (`tests/e2e/conferences.test.js`): a room built in the UI, wrong PIN three times, three browsers sending 440 / 880 / 1320 Hz tones and each measuring exactly the other two (and not itself), mute / unmute / remove / lock from the admin page changing what is heard, admin PIN with key 3, member limit and mute on entry
- Defects found by testing: `CONFBRIDGE(user,muted)` is not an option (`startmuted`), and settings made with `CONFBRIDGE()` are silently ignored when `ConfBridge()` names a profile
- [ ] C2 call parking, C3 attended and blind transfer (hold, REFER), C4 busy-lamp presence and call pickup

---

## Acceptance tests (§75)

Status values: `NOT RUN` · `PASS` · `FAIL` · `MANUAL REQUIRED`. Evidence column = command output / log / trace reference.

| # | Test | Phase | Status | Evidence |
|---|------|-------|--------|----------|
| 1 | Docker Compose config validates | 1 | PASS | `docker compose config -q` exit 0; 4 services, all `restart: unless-stopped`, no `latest` tags |
| 2 | All required containers start | 1 | PASS | `docker compose up -d`: asterisk, backend, database, frontend all running |
| 3 | All applicable healthchecks pass | 1–2 | PASS | all four containers report `healthy` (asterisk: uptime+PJSIP+HTTP+AMI; backend: `/health`; database: `pg_isready`; frontend: HTTPS) |
| 4 | HTTPS works | 2 | PASS | Chromium loads `https://communications.local` (TLS 1.2/1.3, LAN-CA-issued cert); HTTP→HTTPS 301 verified |
| 5 | Browser trusts generated LAN CA after install | 3 | PASS (Chromium/Linux); other OS/browsers MANUAL REQUIRED | Chromium/Linux with the CA in its NSS store loads the site; the same browser without the CA refuses it (`ERR_CERT_AUTHORITY_INVALID`). Windows/macOS/Firefox/mobile install steps: MANUAL REQUIRED (to be documented) |
| 6 | `/health` reports healthy DB and AMI | 2 | PASS | `GET /api/health` via Nginx → `{"status":"ok","checks":{"database":"ok","ami":"connected"}}`; 503 `degraded`/`down` paths unit-tested (live AMI-down check goes into `test-stack.sh`) |
| 7 | Administrator login works | 2 | PASS | unit + live (`curl` over HTTPS); JWT issued, HttpOnly cookie set |
| 8 | Invalid login fails | 2 | PASS | identical 401 for wrong password and unknown user; browser shows the error; rate limit 429 after repeated failures |
| 9 | RBAC works | 2 | PASS | 36-case endpoint × role matrix (unauthenticated/user/operator/admin); read-only user verified in a real browser (UI hidden, API 403) |
| 10 | User management works | 2 | PASS | API level (unit) and in a real browser: create, weak/duplicate refused, edit role + disable (disabled account cannot log in), delete, last administrator protected |
| 11 | 1001 WebRTC registration | 2 | PASS | real Chromium registers over wss://…/ws (Nginx → Asterisk), REGISTER answered 200 OK; dashboard shows Online |
| 12 | 1002 WebRTC registration | 2 | PASS | as above for 1002 |
| 13 | 1001 → 1002 rings, two-way audio | 2 | PASS | INVITE has no paging markers; not auto-answered after 3.5 s; after manual answer 1001 hears only 880 Hz (1002's tone) and 1002 only 440 Hz. See the RTP-port finding in Decisions & open items. |
| 14 | 1002 → 1001 rings, two-way audio | 2 | PASS | same measurement in the reverse direction. See the RTP-port finding in Decisions & open items. |
| 15 | 1001 → 600 real echo audio | 1–2 | PASS | WebRTC: browser hears its own 440 Hz tone back and nothing else; also verified over UDP with a SIP client |
| 16 | Page All works | 2 | PASS | recipient auto-answers, hears the operator's microphone tone; audit request/success/end rows written. See the RTP-port finding in Decisions & open items. |
| 17 | Page Office works | 2 | PASS | 701 from 1002 reaches 1001 only; 701 from 1001 is refused (nobody else to page) |
| 18 | Page Warehouse works | 2 | PASS | 702 from 1001 reaches 1002 only |
| 19 | Recipients auto-answer only with paging markers | 2 | PASS | browser received `X-Paging-Call: true`, `Call-Info …;answer-after=0`, From 700 and answered by itself; gate unit-tested (each condition necessary; generic Call-Info insufficient) |
| 20 | Normal calls do not auto-answer | 2 | PASS | ordinary INVITEs carry no paging headers and keep ringing until Answer is pressed (both directions) |
| 21 | Paging is one-way | 3 | PASS | with RTP flowing (>20 packets) the operator hears neither the recipient's 880 Hz tone nor itself; recipient's controls are listen-only. Also enforced in Asterisk (muted ConfBridge participants, no `d` option) |
| 22 | Paging terminates cleanly | 3 | PASS | End page releases the recipient; both dashboards return to Online; second page is refused while one is live; dead-media timeout and 5-min cap verified in config |
| 23 | Extension state updates in real time | 2 | PASS | dashboards moved through Offline → Online → In-Call → Paging → Online and back to Offline when a browser closed, driven by AMI events over Socket.IO |
| 24 | AMI disconnect/reconnect works (< 10 s) | 2–3 | PASS | `scripts/test-stack.sh` restarts Asterisk and measures from "AMI accepts connections" to `/health` `ami: connected`: **0.8 s** (limit 10 s); also covered by the mock-AMI drop/outage/half-open tests |
| 25 | Audit records are created | 2 | PASS | login, user, originate, hangup, paging.request/success/end/failure/cancel rows verified in PostgreSQL and via the audit API; DB rejects UPDATE/DELETE/TRUNCATE |
| 26 | Invalid call/page destinations rejected | 2 | PASS | 15 malformed originate bodies and 11 invalid page groups rejected with 400 and nothing sent to AMI; direct SIP dial of 700 without a grant refused by Asterisk |
| 27 | PostgreSQL data persists after restart | 3 | PASS | `test-stack.sh`: user count identical before/after `docker compose restart database`, admin can still log in, backend `/health` recovers; named volume `pgdata` |
| 28 | Backup completes successfully | 3 | PASS | `scripts/test-backup-restore.sh` (16/16, run repeatedly): archive with DB dump, Asterisk config + data, certs/keys, manifest + SHA256SUMS; integrity re-verified after writing; no `.env` unless `--include-env`. Archive mode 600 is not verifiable on this NTFS host (reported as NOTE, not as pass) |
| 29 | Restore completes in test environment | 3 | PASS | same script: marker user created before the backup is back, user created after it is gone, audit log restored, admin login + `/health` + paging dialplan OK afterwards; safety backup taken first; a tampered archive is rejected before anything changes (live data untouched) |
| 30 | Physical SIP phone tests | 3 | MANUAL REQUIRED | No physical SIP phone is available in this environment. The phone endpoints (`1001-phone`/`1002-phone`) were verified with a software SIP client over UDP (registration, echo test audio). Steps for the real phone, including the paging-INVITE capture and the DEVICE LIMITATION decision, are in TESTING.md M1 |

Tests 11–22 involve browser microphone/speaker and live audio; anything that cannot be driven or measured automatically stays `MANUAL REQUIRED` with exact steps in `TESTING.md`.

---

## Decisions & open items

| Date | Item | Notes |
|------|------|-------|
| 2026-10-05 | Environment | Docker 28.4.0, Compose v2.39.2, Node 22.16, OpenSSL 3.2.4 available on the build host (Windows 11, Docker Desktop). |
| 2026-10-05 | Host networking caveat | Asterisk requires `network_mode: host` (§7). On Docker Desktop for Windows this binds inside the Docker VM, not the Windows LAN IP — LAN SIP/RTP validation from other devices will need a Linux host or `MANUAL REQUIRED`. Revisit in Phase 1. |
| 2026-10-05 | Asterisk version | Pinned **22.11.0** (SHA256 `3bd5ee04…ba54d94`), Debian 12.12-slim by digest, Digium Opus binary 22.0_1.3.0 (SHA256 `889e6b3d…472e20d`). |
| 2026-10-05 | Phone endpoints | Physical phones register as `1001-phone` / `1002-phone` (a browser WebRTC endpoint and a plain-RTP phone cannot share one PJSIP endpoint). Dialing 1001/1002 rings both; caller ID is still 1001/1002. |
| 2026-10-05 | Config rendering | `./asterisk/config` holds templates mounted read-only; the entrypoint renders them with secrets into `/run/asterisk/etc` (tmpfs) and runs Asterisk with `-C`. CLI/healthcheck must pass `-C /run/asterisk/etc/asterisk.conf`. |
| 2026-10-05 | `/var/lib/asterisk` volume | Hides image content on upgrade, so the entrypoint refreshes `documentation/` (required for the Opus module to register) from an image copy on each start. |
| 2026-10-05 | Docker Desktop caveat confirmed | Host networking works but binds inside the Docker VM (eth0 192.168.65.3). Bridge containers reach Asterisk at the bridge gateway (e.g. 172.17.0.1), and `host.docker.internal` points at Windows, not the VM — set `ASTERISK_HOST` accordingly when testing on Windows. LAN/SIP-phone/browser tests from other devices need a Linux host or are `MANUAL REQUIRED`. |
| 2026-10-05 | **Root cause of the intermittent browser E2E failure: RTP port 10080** | Chromium (and Firefox) refuse to send to their restricted "bad ports", and UDP **10080** is the only one inside the old RTP range 10000–10200. A call whose RTP landed there signalled fine, but the browser never sent a STUN/RTP packet and nothing arrived (ICE stuck in `checking`, 0 packets): about 1 call in 100 in production. Evidence: a packet capture inside the Docker VM showed Asterisk sending checks to the browser while **no** packet from that browser socket ever appeared; the failing pair was port 10080 in 5 of 5 captured cases; the kernel showed no socket behind the browser candidate. **Fix:** default range moved to **10100–10300**, and the Asterisk entrypoint refuses to start with a range containing a browser-restricted port. Result: 15 consecutive full E2E runs (225/225 tests) with no failure; before the fix 4 of 15 runs failed, and further runs failed in later batches. |
| 2026-10-05 | Two "connected but silent" E2E failures not explained | Two earlier failures (RTP ports 10146 and 10142) had ICE connected and RTP flowing, but the decoded tone absent. They did **not** recur in the 15 runs after the fix, but the cause was not isolated: recorded as a possible rare residual, not as solved. On failure the test now records the operator microphone level, kernel socket state and every ICE pair, so a recurrence can be diagnosed. |
| 2026-10-05 | ICE candidate truncation | Asterisk keeps only 16 local ICE candidates in unspecified order; with 34 interfaces in the Docker VM the reachable one randomly vanished. `ICE_PERMIT` (default `LAN_SUBNET`) now limits offered addresses via `ice_deny`/`ice_permit`. |
| 2026-10-05 | Stuck calls after a browser dies | `rtp_timeout=30` hangs up a call with no media for 30 s; a page is capped at 5 minutes (`TIMEOUT(absolute)`). The audit writer retries with a null user when the user was deleted mid-page (FK violation). |
| 2026-10-05 | Paging identity | `CALLERID()` had no effect on the outbound PJSIP From header; the paging identity (700/701/702) is set with `CONNECTEDLINE(num/name)` in `sub-page-prep`. |
| 2026-10-05 | Windows host notes | Git Bash needs `MSYS_NO_PATHCONV=1`; the Windows curl returns exit 23 for `-o /dev/null` (scripts avoid it under `set -e`); a `tar` piped into `grep -q` under `pipefail` can die of SIGPIPE (fixed in restore.sh); file modes cannot be enforced on NTFS (backup/restore report this instead of claiming it). The test scripts need no Python. |
| 2026-10-05 | Fresh-clone deployment test found two packaging defects | Cloning the repository elsewhere, generating a new `.env` + certificates and building (`COMPOSE_PROJECT_NAME=fresh`) failed at first: (1) `backend/migrations/001_init.sql` was never committed — the `*.sql` ignore rule swallowed it, so nobody else could build the backend; (2) `test-backend.sh` assumed `node_modules` already existed. Both fixed. After the fixes the fresh copy (empty volumes, new secrets, new CA) built, became healthy and passed: stack 62/62, backend 143/143, frontend unit 9/9, browser 18/18, backup/restore 16/16, resilience 6/6. The copy and its volumes were then removed. Docker layers were reused from the build cache (inputs identical), so this proves reproducibility of the build from the repository contents, not a cold recompile of Asterisk. |
| 2026-10-05 | Backend outage was not detected by the SPA | With the backend stopped, Nginx answers 502 — a successful HTTP exchange — so the SPA kept believing the backend was fine and showed only a small "Reconnecting…" chip. Fixed: a gateway error without the backend's own JSON error body counts as "unreachable", and a dropped live socket triggers a probe. Verified with a real backend stop in real browsers (scripts/test-resilience.sh). |
| 2026-10-05 | Backend shutdown hung while browsers were connected | `server.close()` only resolves when every connection has ended, but the Socket.IO connections were closed after it, so shutdown always waited for the 10 s forced exit. Fixed (sockets closed first); shutdown now completes in milliseconds and the resilience test asserts it. |
| 2026-10-05 | Microphone refusal wording | Chromium can refuse with `NotSupportedError` (not only `NotAllowedError`); the UI used to show "Could not enable audio: Not supported". Every `getUserMedia` failure now has specific guidance (unit-tested and verified in a browser). |
| 2026-10-06 | Windows SIP phone (`SIP Phone/`) | New folder next to `asterisk/`: a WinForms softphone (`SIP Phone.exe`, single self-contained file built by `SIP Phone/build.ps1`) on SIPSorcery 10.0.17 (pinned: 8.0.23 has two high-severity DoS advisories) and NAudio. Registers as a physical-phone endpoint (UDP 5060, digest auth), answers the PBX's OPTIONS keep-alive, G.711, RFC 4733 DTMF, auto-answers pages with the same three-marker rule as the browser (listen-only, mic never sent), refuses INVITEs not coming from the PBX. Verified: 70 unit tests; 48 end-to-end checks against the real Asterisk and backend (`SIP Phone/test-sipphone.sh`, run twice, the second time with the 35 s keep-alive wait); the exe starts and its first-run and main windows were inspected. **NOT verified:** a call from the Windows program itself (Docker Desktop's host network is inside the VM, so this PC cannot reach SIP), the sound-card path and the Windows Firewall prompt: MANUAL REQUIRED, TESTING.md M5. The exe is not committed (70 MB, git-ignored); `build.ps1` rebuilds it. |
| 2026-10-06 | Three phone-engine defects found only by testing against the real PBX | (1) The outgoing INVITE had no `Content-Type: application/sdp`: Asterisk treated it as an offer-less INVITE, waited for the answer in the ACK and hung up with "incomplete SDP negotiation" the moment the ACK arrived (calls "connected" for 1 ms). (2) SIPSorcery 10 delivers received audio to the sink as frames, not through the RTP callback, so the first build was silent. (3) `Call-Info` is not in SIPSorcery's unknown-header list (parsed internally), so every page was treated as an ordinary call and rang instead of auto-answering. Each is fixed and covered by the end-to-end test; (3) and the server-address check (a `sip:` prefix was accepted) also have unit tests. |
