# LAN Communications & Intercom Stack

A completely self-hosted, LAN-only phone system and intercom:

- browser softphones (WebRTC) and physical SIP phones (UDP) on Asterisk,
- extension-to-extension calls, an echo test, and **live one-way paging** to groups,
- **extensions, SIP trunks (provider, registration or IP, another PBX, GSM/FXO gateway), inbound numbers (DIDs) and
  outbound routes managed entirely in the web UI**, applied to Asterisk live without a restart,
- a **call history** with filters, statistics and CSV export,
- a web dashboard with real-time extension state, user management and an audit log,
- HTTPS/WSS terminated by Nginx with a local certificate authority,
- no cloud telephony, no external database, no external identity provider.

> Status and verification evidence live in [TRACKER.md](TRACKER.md). The original requirements are in [task.md](task.md).
> How to deploy: [DEPLOYMENT.md](DEPLOYMENT.md). How it is tested: [TESTING.md](TESTING.md).

## Architecture

```
 Browser (HTTPS :443)                     Physical SIP phone
   |  https://SERVER/        (SPA)           |  SIP/UDP :5060, RTP/UDP 10100-10300
   |  https://SERVER/api     (REST)          |
   |  https://SERVER/socket.io (live state)  |
   |  wss://SERVER/ws        (SIP over WS)   |
   v                                          v
 +--------------------+  http   +------------------+      +------------------------+
 |  frontend (Nginx)  |-------->| backend (Node)   |<---->| database (PostgreSQL16)|
 |  TLS, static SPA,  |  :3000  | Express, JWT,    |      | users, audit_logs      |
 |  /api /socket.io   |         | RBAC, Socket.IO  |      +------------------------+
 |  /ws proxy         |         +---------+--------+
 +---------+----------+                   | AMI :5038 (TCP, ACL-restricted)
           | plain WS :8088/ws            v
           +--------------------> +------------------+   host networking
                                  | asterisk 22.11.0 |   (SIP, RTP, WS, AMI on the host)
                                  | PJSIP, ConfBridge|
                                  +------------------+
```

Four containers, all `restart: unless-stopped` with real health checks:

| Service | Image / base | Role |
|---|---|---|
| `asterisk` | built from source on `debian:12.12-slim` (digest-pinned) | PBX: PJSIP UDP + WebSocket transports, dialplan, `Page()`, AMI. Host networking. Runs as an unprivileged user |
| `backend` | `node:22.20.0-bookworm-slim` (digest-pinned) | REST API, JWT auth, RBAC, audit, AMI client, real-time state, paging authorisation, PBX configuration (extensions, trunks, routes) and its application to Asterisk, call records |
| `frontend` | `nginx:1.28.0-alpine` (digest-pinned) | TLS termination, SPA, reverse proxy for `/api`, `/socket.io`, `/ws` |
| `database` | `postgres:16.10-alpine` (digest-pinned) | persistence; never published to the host |

### Pinned versions

| Component | Version |
|---|---|
| Asterisk | **22.11.0** (22.x LTS), source SHA-256 verified in the Dockerfile |
| Opus transcoding module | Sangoma `codec_opus` 22.0_1.3.0 (binary, SHA-256 pinned) |
| PostgreSQL | 16.10 |
| Node.js | 22.20.0 |
| Nginx | 1.28.0 |
| SIP.js (browser SIP client) | 0.21.2 |
| Express / pg / zod / socket.io / pino | 5.2.1 / 8.23.1 / 4.6.5 / 4.8.4 / 10.4.0 |

All npm dependencies are pinned to exact versions with committed lockfiles (`npm ci` fails on drift). Debian's own
apt packages inside the Asterisk image are not version-pinned (there is no snapshot repository), which is a known limitation.

## Extensions, trunks and routes

Everything below is managed in the web UI (administrators only) and stored in PostgreSQL. The backend renders it into
Asterisk configuration (a volume shared with Asterisk) and reloads Asterisk over AMI, so a change is live within about a
second and nobody is disconnected. The **System** page shows whether Asterisk is running exactly what the database says.

```
 Extensions / Trunks / Routes pages  ->  REST /api/pbx/*  ->  PostgreSQL (source of truth)
                                                        |
                              render (pure, strictly whitelisted)  ->  pjsip_generated.conf + extensions_generated.conf
                                                        |                         (volume shared with Asterisk)
                                            AMI: module reload res_pjsip.so, dialplan reload
```

| Page | What you manage |
|---|---|
| **Extensions** | extension number and name, browser softphone and/or physical phone login, permission to place outside calls, outbound caller ID, SIP credentials (shown on request, audited, regeneratable); **paging groups** and their members |
| **Trunks** | SIP providers that give you phone numbers (registration with username/password, or IP-authenticated), another PBX, or a GSM/FXO gateway. Live status from Asterisk: registered / rejected, reachable / not answering, active calls. Optional channel limit, codecs, DTMF mode, caller ID |
| **Routes** | *Inbound*: which extension (or the echo test, or a rejection) a phone number rings, per trunk or for all trunks, with a catch-all. *Outbound*: dial patterns (e.g. `_9NXXNXXXXXX`), digits to strip/add, trunks tried in order (failover), caller ID, emergency routes. Route **order** is the priority |
| **Call flow** | *Ring groups* (all at once or in order, with a fallback destination; people on do-not-disturb are skipped) and *business hours* (time conditions with open periods, closed days, a time zone, and one-click Open / Closed overrides). Per extension: do not disturb, forward all, forward when busy, forward when unanswered; people set their own do-not-disturb and forwarding on their dashboard |
| **Call queues** (on the Call flow page) | Callers wait (hearing ringing) for an agent: ring everyone, longest idle, fewest calls, round robin, random, or in order; agent ring time and rest time, maximum wait, maximum callers, fall-back destination, refuse to queue when nobody is online. Live agent states and waiting callers from Asterisk; today's answered / abandoned / turned-away counts, average wait and talk time and service level, all from Asterisk's own queue events. Agents pause and resume themselves on the dashboard |
| **Menus & audio** | *Audio prompts* (upload WAV/MP3/M4A or record with the microphone; converted to telephone quality in the browser and again on the server; preview in the page), *announcements* (play a prompt, then continue or hang up) and *menus* (IVR: "press 1 for sales"; keys lead to any destination, repeat count, fall-back, optional direct extension dialling). The softphone has an on-screen keypad for menus |
| **Call history** | every call with direction, trunk, result and talk time; filters; per-day / per-hour charts, busiest numbers; CSV export |

Built-in numbers: `600` is the echo test. Two extensions and three paging groups are created on first start so an existing
installation keeps working: `1001` Office, `1002` Warehouse, `700` Page All, `701` Page Office, `702` Page Warehouse. They can
be edited or deleted like any other. Extension and paging-group numbers are 3 to 6 digits and cannot overlap.

Outbound calls are **off by default for every extension** (toll-fraud protection): enable "May place outbound calls" per
extension. Emergency routes are the only exception. Internal extensions always win over an outbound pattern.

Physical phones register with a separate PJSIP endpoint, `<number>-phone` (a WebRTC endpoint and a plain-RTP
phone cannot share one endpoint). Dialling an extension rings its browser and its phone in parallel, and caller ID is
still presented as the extension number.

## Paging: where the microphone audio comes from

Live paging needs a real media source, so the backend never "originates a page" by itself. The flow is:

```
Dashboard "Page" button
   -> POST /api/page {group}      backend checks JWT + role, validates the group, refuses concurrent pages,
                                  writes an audit record, and stores a short-lived single-use grant in
                                  Asterisk's AstDB (AMI DBPut: page_auth/<operator ext> = "<group>:<expiry>")
   -> operator's own browser      places a normal SIP call from its registered extension to 700/701/702
                                  using the operator's microphone (getUserMedia)
   -> Asterisk dialplan           consumes the grant (refuses the call if there is none / it expired / wrong group),
                                  builds the target list WITHOUT the caller, adds the paging headers per leg
   -> Page()                      each target gets an INVITE and joins a ConfBridge as a muted participant
   -> recipients' browsers        see the headers, auto-answer, and play the audio. They cannot talk back.
```

Consequences worth knowing:

- A SIP password alone cannot page. Dialling 700 directly without the backend grant is rejected by Asterisk.
- The `user` role cannot page: the backend refuses to issue a grant, and the role has no softphone.
- Paging is one-way by construction: `Page()` is used **without** the `d` (duplex) option, so recipients are muted in the
  bridge; the browsers also keep their own microphone disabled.
- Targets that are busy or unreachable are skipped (`s` option); the caller is never paged (self-page prevention).
- A page is capped at 5 minutes, and a call is hung up when no media arrives for 30 s, so a crashed browser cannot
  leave a page stuck "on air".

### Paging headers

Each outgoing paging INVITE carries (verified in the SIP trace and as received by the browser):

```
From: "Paging" <sip:700@host>                       (701 / 702 for the other groups)
Call-Info: <sip:communications.local>;answer-after=0
X-Paging-Call: true
P-Asserted-Identity: Paging System <sip:paging@communications.local>
```

### Browser auto-answer rule

A browser answers by itself **only if all** of these hold (`frontend/src/paging-detect.js`, unit-tested):

1. the caller user is `700`, `701` or `702`;
2. `X-Paging-Call` is exactly `true`;
3. `Call-Info` contains the `answer-after=0` parameter.

A generic `Call-Info` header, or any ordinary call, keeps ringing until the user answers.

### Browser permissions (honest note)

Browsers cannot be forced to grant microphone access, secure-origin status or audio playback. After login, operators
click **Enable microphone and audio** once per page load. That grants the microphone and unlocks playback; after that
pages are answered and played without further interaction. If the browser still blocks playback, the dashboard shows a
"Click to enable sound" banner. The site must be opened over HTTPS with the LAN CA trusted, otherwise `getUserMedia` is
unavailable.

## Authentication, sessions and roles

- `POST /api/auth/login` verifies the password (bcrypt, cost 12) and issues an HS256 JWT with issuer and audience,
  signed with `JWT_SECRET` (at least 32 characters, from the environment).
- **Browser sessions use an HttpOnly, Secure, SameSite=Strict cookie** (`session`). The SPA never sees or stores the
  token (nothing in `localStorage`/`sessionStorage`). The JSON response also carries the token for non-browser API
  clients, which may send it as `Authorization: Bearer`.
- The access token lives 15 minutes; the SPA renews it every 5 minutes (sliding), up to an absolute session maximum of
  12 hours. Expired, tampered, wrong-secret, wrong-audience and `alg=none` tokens are rejected.
- The role is **not** stored in the token. It is read from the database on every request, so deactivating, demoting or
  resetting a user takes effect immediately (and drops their live sockets).
- Login attempts are rate limited per IP + username (default 10 failures per 15 minutes); responses never reveal whether
  a username exists.
- State-changing requests from another origin are rejected.

| Role | Dashboard / extension status | Originate calls | Paging | Users | Audit log / system status |
|---|---|---|---|---|---|
| `admin` | yes | yes | yes | yes | yes |
| `operator` | yes | yes | yes | no | no |
| `user` | read-only | no | no | no | no |

Authorisation is enforced by the backend; hiding buttons in the UI is only a convenience. The initial `admin` account is
created once from `ADMIN_PASSWORD` and is never overwritten on later starts. The last active administrator cannot be
deleted, disabled or demoted. Audit records (PostgreSQL) are append-only: the database itself rejects UPDATE, DELETE
and TRUNCATE.

## API overview

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/auth/login`, `/logout`, `/refresh`; `GET /api/auth/me` | any / authenticated | session handling |
| `GET /api/extensions` | any authenticated | live state of every extension, paging groups |
| `GET /api/sip/config` | admin, operator (with an extension) | the caller's own SIP credentials for the browser softphone |
| `POST /api/originate` `{from,to}` | admin, operator | click-to-call between configured extensions |
| `POST /api/hangup` `{extension}` | admin, operator | hang up an extension's live channels |
| `POST /api/page` `{group}`, `GET`/`DELETE /api/page` | admin, operator | authorise / inspect / force-end a page |
| `GET/POST/PATCH/DELETE /api/users` | admin | user management |
| `GET /api/audit` | admin | audit log (filters, paging) |
| `GET /api/system/status` | admin | backend, database, AMI, Asterisk, trunk and configuration-apply status |
| `GET/POST/PATCH/DELETE /api/pbx/extensions`, `.../:id/credentials`, `.../:id/regenerate-secret` | admin | extensions and their SIP credentials |
| `GET/POST/PATCH/DELETE /api/pbx/paging-groups` | admin | paging groups and members |
| `GET/POST/PATCH/DELETE /api/pbx/trunks`, `GET /api/pbx/trunks/status` | admin | trunks and their live status |
| `GET/POST/PATCH/DELETE /api/pbx/inbound-routes`, `/outbound-routes` | admin | inbound numbers and outbound routes |
| `GET /api/pbx/apply`, `POST /api/pbx/apply` | admin | configuration apply status / re-apply now |
| `GET /api/cdr`, `/api/cdr/stats`, `/api/cdr/export.csv` | admin | call history, statistics, CSV |
| `GET /health`, `/api/health`, `/health/live` | public | readiness (200 only if database **and** AMI are healthy) / liveness |

### Real-time events (Socket.IO at `/socket.io`)

`extension.snapshot`, `extension.status.changed {extension,name,state,registered,clients}`, `call.started`,
`call.ended`, `paging.started`, `paging.ended`, `paging.failed`, and for administrators only `ami.snapshot`,
`ami.connected`, `ami.disconnected`. Extension state is **Online / Offline / In-Call / Paging**, derived from real
Asterisk events (ContactStatus, DeviceStateChange, DialEnd, Hangup and the dialplan's page events); while AMI is down it
is reported as **Unknown** rather than guessed.

## Repository layout

```
docker-compose.yml        the four services
.env.example              every setting, documented (copy to .env or run scripts/init-env.sh)
asterisk/                 Dockerfile, entrypoint (renders config templates with secrets), healthcheck, config/*.conf
backend/                  Express app (src/), migrations/, tests/
frontend/                 SPA (src/), Nginx template, build script, unit tests
tests/e2e/                real-browser (Chromium) end-to-end tests
scripts/                  init-env, generate-certs, backup, restore, test-backend, test-e2e, test-stack, test-backup-restore, test-resilience
SIP Phone/                Windows SIP phone (dialer): source, build script, tests; see SIP Phone/README.md
```

### Windows SIP phone

`SIP Phone/` contains a small Windows softphone that registers like a physical IP phone (DEPLOYMENT.md section 9) and can place
calls, take calls and auto-answer pages. Build the single-file `SIP Phone/dist/SIP Phone.exe` with `SIP Phone/build.ps1`
(needs the .NET 8 SDK; the exe itself needs nothing). Setup, use and limits are in [SIP Phone/README.md](SIP%20Phone/README.md).

## Quick start

```bash
./scripts/init-env.sh             # creates .env with random secrets
# edit .env: SERVER_IP, SERVER_HOSTNAME, LAN_SUBNET (see DEPLOYMENT.md)
./scripts/generate-certs.sh       # LAN CA, Nginx certificate, separate Asterisk DTLS certificate
docker compose up -d --build
```

Then open `https://<SERVER_HOSTNAME>/`, sign in as `admin` with `ADMIN_PASSWORD`, create operator users and assign each
one extension. Full instructions, certificate installation, DNS/hosts, firewall rules and phone setup are in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Known limitations

- Asterisk uses host networking, as required. On Docker Desktop (Windows/macOS) that is the Docker VM's network, not the
  PC's LAN address: browsers or phones on other devices need a Linux host. See DEPLOYMENT.md.
- SIP auto-answer headers are not standardised across phone vendors; physical-phone paging must be verified per model.
- Browser microphone/autoplay rules require the one-click audio enable after each page load and HTTPS with a trusted CA.
- Debian packages inside the Asterisk image are not version-pinned.
- The login rate limit and the single-active-page rule are per backend instance (a single instance is deployed).
- Trunks use UDP or TCP signalling and unencrypted RTP (TLS/SRTP trunks are not offered yet). Behind NAT, a provider that needs
  a public address in the SDP requires the server to have a routable address; this stack is designed for a LAN.
