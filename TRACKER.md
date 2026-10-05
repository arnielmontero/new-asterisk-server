# LAN Communications & Intercom Stack — Build Tracker

Source spec: [task.md](task.md) (section numbers below, e.g. `§33`, refer to it).
Update this file as work lands. Status is only moved to `PASS` after the behavior was **actually run and observed** (spec §74 — no fake success).

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done and verified · `MANUAL REQUIRED` needs hardware/human · `BLOCKED` cannot proceed (reason noted)

**Last updated:** 2026-10-05

---

## Progress summary

| Phase | Scope | Spec priority steps (§78) | Done | Status |
|-------|-------|---------------------------|------|--------|
| 1 | Foundation & Telephony Core | 1–4 | 0 / 27 | Not started |
| 2 | Application: Backend, Frontend, Calls & Paging | 5–11 | 0 / 37 | Not started |
| 3 | Hardening, Validation & Delivery | 12–17 | 0 / 24 | Not started |
| | **Total** | | **0 / 88** | |

Phase gate rule (§78): do not start the next phase while the previous phase's exit criteria are failing.

---

## Phase 1 — Foundation & Telephony Core

Goal: a running, pinned Asterisk 22 LTS container that accepts SIP (UDP) and WebRTC (WS) registrations for 1001/1002 and answers the echo test, with TLS material generated.

### 1.1 Repository & Docker foundation (§54, §55, §70)
- [ ] Project structure (`asterisk/`, `backend/`, `frontend/`, `scripts/`)
- [ ] `.gitignore` (env, keys, certs, dumps, logs, node_modules)
- [ ] `.env.example` with all variables from §55 (+ RTP range, LAN subnet, etc.)
- [ ] `docker-compose.yml`: 4 services, `restart: unless-stopped`, healthchecks, pinned images, `host-gateway` mapping (§6, §14)
- [ ] `docker compose config` validates

### 1.2 Asterisk exact pinned build (§7, §8)
- [ ] Select one exact 22.x LTS patch version; record version + SHA256 in Dockerfile
- [ ] Debian base image pinned (tag/digest), build deps pinned where practical
- [ ] Dockerfile builds with PJSIP, res_http_websocket, DTLS-SRTP, Opus, Page(), Echo(), Dial()
- [ ] Runs as non-root user; host networking; volume mounts per §7
- [ ] Healthcheck (`asterisk -rx "core show uptime"`) detects a hung/dead Asterisk
- [ ] Runtime check: required modules actually loaded (`module show`)

### 1.3 Base Asterisk config (§9–§12, §25–§26)
- [ ] `asterisk.conf`, `modules.conf`, `logger.conf`
- [ ] `http.conf` — plain WS on `0.0.0.0:8088`, `/ws`
- [ ] `rtp.conf` — explicit RTP port range
- [ ] `manager.conf` — dedicated AMI user, least-privilege, ACL restricted
- [ ] Config templating: secrets from env, none committed (§3)

### 1.4 PJSIP transports & endpoints (§10, §11, §43)
- [ ] UDP transport :5060; WebSocket transport
- [ ] `allow_guest=no`, no anonymous endpoint, LAN ACL
- [ ] Endpoint 1001 (Office) / 1002 (Warehouse) — WebRTC profile (DTLS, ICE, AVPF, opus/ulaw/alaw)
- [ ] Endpoint profile for physical SIP phones (UDP)

### 1.5 Basic dialplan (§33, §41)
- [ ] 1001 ↔ 1002 direct dial, 30 s timeout
- [ ] 600 Echo test (Answer / Echo / Hangup)

### 1.6 Certificates (§12, §15, §53) — script only; hardening in Phase 3
- [ ] `scripts/generate-certs.sh`: LAN CA, Nginx cert (SANs from `SERVER_IP`/`SERVER_HOSTNAME`), separate Asterisk DTLS cert/key

### Phase 1 exit criteria
- [ ] Asterisk container `healthy`; exact version printed from `core show version`
- [ ] `pjsip show transports` lists UDP + WS; `pjsip show endpoints` lists 1001/1002
- [ ] `http show status` shows WS on 8088; DTLS cert loads without error
- [ ] A real SIP client registers on UDP and 600 returns echo — or marked `MANUAL REQUIRED`

---

## Phase 2 — Application: Backend, Frontend, Calls & Paging

Goal: authenticated dashboard with real-time extension state, softphone, normal calls, and live one-way paging with browser auto-answer.

### 2.1 Backend core — PostgreSQL / auth / RBAC (§17–§24, §46, §49–§50)
- [ ] Express app, modular layout (auth, users, extensions, paging, calls, audit, ami, database, socket, health, validation)
- [ ] DB connection with retry; versioned idempotent migrations
- [ ] `users` + `audit_logs` tables, indexes, FKs
- [ ] Admin bootstrap from `ADMIN_PASSWORD` (idempotent, no overwrite, not logged)
- [ ] `POST /api/auth/login` — JWT, Argon2id/bcrypt, rate limit, HttpOnly cookie handling documented
- [ ] RBAC middleware (admin / operator / user) enforced server-side
- [ ] User CRUD `GET/POST/PATCH/DELETE /api/users` + last-admin protection
- [ ] Input validation library, body-size limit, safe errors (no stack traces)
- [ ] Structured logging with secret redaction
- [ ] Audit logging for all events listed in §32

### 2.2 AMI integration & real-time state (§25, §27–§29, §58, §69)
- [ ] AMI client: auth, events, exponential backoff, reset on success, state exposed
- [ ] Extension state derived from real AMI events (ContactStatus, DeviceStateChange, DialBegin/End, Bridge*, Hangup)
- [ ] Normalized states: Online / Offline / In-Call / Paging
- [ ] Socket.IO with authenticated connections; events per §28 documented
- [ ] `GET /health` reflects DB **and** AMI honestly (degraded when AMI down)
- [ ] Graceful shutdown (HTTP, Socket.IO, AMI, DB)

### 2.3 Frontend SPA & softphone (§35–§40, §65, §67–§68)
- [ ] Pin SIP.js (or JsSIP) exact version
- [ ] Login page; first-use "Enable Microphone / Audio" gate
- [ ] Dashboard: 1001/1002 state, call/hangup, paging buttons (role-aware)
- [ ] Softphone: register (WSS), call, incoming answer/reject/hangup, call state, echo test
- [ ] SIP registration state shown separately from dashboard login
- [ ] User management page, audit log page, system status page (admin)
- [ ] Error handling for all cases in §67; reconnect behavior
- [ ] Nginx: HTTPS, HTTP→HTTPS, `/api`, `/socket.io`, `/ws` proxy, security headers, `ASTERISK_HOST` templating (§13, §14, §47)

### 2.4 Normal calling (§30)
- [ ] `POST /api/originate` — strict validation, configured extensions only, audited
- [ ] Browser 1001 ↔ 1002 manual-answer two-way calls

### 2.5 Paging (§4, §5, §31, §33–§35)
- [ ] Audio-source architecture implemented: dashboard → backend authorize+audit → operator's browser SIP call → paging extension → `Page()`
- [ ] `POST /api/page` (700/701/702 only), concurrency guard, audit
- [ ] Version-correct `Page()` dialplan + pre-dial handler with `PJSIP_HEADER()`
- [ ] Outgoing INVITE carries `X-Paging-Call: true`, `Call-Info` auto-answer, `P-Asserted-Identity`
- [ ] Self-page prevention (initiator excluded from group)
- [ ] Browser auto-answer gated on **all** conditions (known group + `X-Paging-Call` + `answer-after=0`)
- [ ] One-way audio (recipients cannot talk back)
- [ ] `paging.started` / `paging.ended` events reach dashboard

### Phase 2 exit criteria
- [ ] Backend test suite green (auth, RBAC, users, calls, paging, DB, health)
- [ ] Browser can register as 1001 and 1002 over WSS
- [ ] INVITE headers for paging captured from a real SIP trace

---

## Phase 3 — Hardening, Validation & Delivery

Goal: secure, backed-up, tested, documented, and honestly verified end to end.

### 3.1 Physical phone compatibility (§42, §66)
- [ ] Physical SIP phone profile + docs
- [ ] Hardware tests run, or recorded as `MANUAL REQUIRED` / `DEVICE LIMITATION`

### 3.2 TLS / PKI / security hardening (§15, §16, §43, §45–§48)
- [ ] Generated certs verified: SANs, permissions, repeat-safe, never committed
- [ ] CSP / security headers don't break mic/WebRTC
- [ ] Firewall rules documented (LAN-only; AMI, 8088, Postgres not exposed)
- [ ] CORS same-origin; no wildcard
- [ ] Secrets scan: nothing sensitive in logs or git

### 3.3 Backup & restore (§51–§52)
- [ ] `scripts/backup.sh` (timestamped, secure perms, integrity check)
- [ ] `scripts/restore.sh` (path validation, safeguards, health check after)
- [ ] Backup and restore actually run on a test environment

### 3.4 Automated tests (§59–§60)
- [ ] Backend: auth, RBAC, users, calls, paging, DB, health, AMI reconnect
- [ ] Asterisk config tests: endpoints, dialplan, modules, transports
- [ ] `scripts/test-stack.sh` covering all 17 checks in §60, non-zero exit on failure

### 3.5 Runtime / telephony acceptance (§61–§64, §75)
- [ ] Real SIP signaling capture proves paging headers (§62)
- [ ] Audio verified where possible (RTP packet/audio inspection); else `MANUAL REQUIRED` with exact steps
- [ ] One-way paging verified behaviorally (§64)
- [ ] Normal calls confirmed not auto-answering
- [ ] Logs reviewed; errors fixed; failed tests repeated

### 3.6 Documentation (§71–§72)
- [ ] `README.md` (architecture, requirements, install, JWT handling, pinned versions)
- [ ] `DEPLOYMENT.md` (certs, DNS/hosts, firewall, browser + phone setup, backup/restore)
- [ ] `TESTING.md` (procedures, MANUAL REQUIRED steps)
- [ ] Troubleshooting + known browser/phone limitations
- [ ] Final completion report (§77)

### Phase 3 exit criteria
- [ ] All 30 acceptance tests below are `PASS` or `MANUAL REQUIRED` — none unverified, none silently skipped

---

## Acceptance tests (§75)

Status values: `NOT RUN` · `PASS` · `FAIL` · `MANUAL REQUIRED`. Evidence column = command output / log / trace reference.

| # | Test | Phase | Status | Evidence |
|---|------|-------|--------|----------|
| 1 | Docker Compose config validates | 1 | NOT RUN | |
| 2 | All required containers start | 1 | NOT RUN | |
| 3 | All applicable healthchecks pass | 1–2 | NOT RUN | |
| 4 | HTTPS works | 2 | NOT RUN | |
| 5 | Browser trusts generated LAN CA after install | 3 | NOT RUN | |
| 6 | `/health` reports healthy DB and AMI | 2 | NOT RUN | |
| 7 | Administrator login works | 2 | NOT RUN | |
| 8 | Invalid login fails | 2 | NOT RUN | |
| 9 | RBAC works | 2 | NOT RUN | |
| 10 | User management works | 2 | NOT RUN | |
| 11 | 1001 WebRTC registration | 2 | NOT RUN | |
| 12 | 1002 WebRTC registration | 2 | NOT RUN | |
| 13 | 1001 → 1002 rings, two-way audio | 2 | NOT RUN | |
| 14 | 1002 → 1001 rings, two-way audio | 2 | NOT RUN | |
| 15 | 1001 → 600 real echo audio | 1–2 | NOT RUN | |
| 16 | Page All works | 2 | NOT RUN | |
| 17 | Page Office works | 2 | NOT RUN | |
| 18 | Page Warehouse works | 2 | NOT RUN | |
| 19 | Recipients auto-answer only with paging markers | 2 | NOT RUN | |
| 20 | Normal calls do not auto-answer | 2 | NOT RUN | |
| 21 | Paging is one-way | 3 | NOT RUN | |
| 22 | Paging terminates cleanly | 3 | NOT RUN | |
| 23 | Extension state updates in real time | 2 | NOT RUN | |
| 24 | AMI disconnect/reconnect works (< 10 s) | 2–3 | NOT RUN | |
| 25 | Audit records are created | 2 | NOT RUN | |
| 26 | Invalid call/page destinations rejected | 2 | NOT RUN | |
| 27 | PostgreSQL data persists after restart | 3 | NOT RUN | |
| 28 | Backup completes successfully | 3 | NOT RUN | |
| 29 | Restore completes in test environment | 3 | NOT RUN | |
| 30 | Physical SIP phone tests | 3 | NOT RUN | |

Tests 11–22 involve browser microphone/speaker and live audio; anything that cannot be driven or measured automatically stays `MANUAL REQUIRED` with exact steps in `TESTING.md`.

---

## Decisions & open items

| Date | Item | Notes |
|------|------|-------|
| 2026-10-05 | Environment | Docker 28.4.0, Compose v2.39.2, Node 22.16, OpenSSL 3.2.4 available on the build host (Windows 11, Docker Desktop). |
| 2026-10-05 | Host networking caveat | Asterisk requires `network_mode: host` (§7). On Docker Desktop for Windows this binds inside the Docker VM, not the Windows LAN IP — LAN SIP/RTP validation from other devices will need a Linux host or `MANUAL REQUIRED`. Revisit in Phase 1. |
| | Asterisk version | To be selected and checksum-verified in Phase 1.2. |
