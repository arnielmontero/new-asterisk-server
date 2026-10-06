# Testing

Nothing in the production path is mocked. Mocks (a scripted AMI, a mock AMI TCP server, fake microphone devices) exist
only inside the tests. Results and evidence per acceptance test are tracked in [TRACKER.md](TRACKER.md); a test is only
marked PASS after it was actually run and observed. Anything that needs hardware or a human is **MANUAL REQUIRED**.

## Layers

| Layer | Command | What it covers |
|---|---|---|
| Backend (222 tests) | `./scripts/test-backend.sh` | Authentication (valid/invalid, expired, tampered, wrong audience, `alg=none`, rate limit, session cap), RBAC matrix (anonymous / user / operator / admin), user management (create, update, deactivate, delete, validation, duplicates, last-admin protection incl. concurrent demotion), call origination and hangup (strict validation, offline/busy/AMI-down, audit), paging (valid/invalid group, authorisation grant written to Asterisk, concurrency, lifecycle from events, timeout, force-end), database (migrations fresh/re-run/concurrent/tamper/rollback, persistence, constraints, append-only audit), health, the AMI client against a mock AMI server (login, correlation, event lists, drop/outage/half-open reconnect with backoff, clean stop), extension-state derivation, Socket.IO (authentication, events, role filtering), **PBX management** (extension/trunk/route/paging-group CRUD, validation and injection attempts, secrets never listed or audited, uniqueness and in-use protection, apply-to-Asterisk through AMI incl. debounce, AMI-down catch-up and reload failure), the **config renderer** (every field rendered into Asterisk configuration is whitelisted: a hostile value throws instead of injecting; route order; inbound/outbound structure) and **call records** (ingest, direction, de-duplication, filters, statistics, CSV formula neutralisation, retention) plus live trunk status. Runs inside a Node container against the stack's real PostgreSQL (each file uses a throw-away database) |
| Admin pages and trunk calls (9 tests) | `TEST_FILE=admin-pbx.test.js ./scripts/test-e2e.sh` | an administrator builds an extension, a trunk (pointing at the PBX itself), an inbound route and an outbound route **through the web UI**; a real browser operator then dials an outside number: the call leaves through the outbound route, returns through the trunk and inbound route, and the measured echo of the caller's own 440 Hz tone proves two-way audio; the same call from an extension without outbound permission is refused; the call history shows both legs with direction and trunk; CSV, audit entries without secrets, 403 for non-admins, no script/CSP errors on any page |
| Frontend unit (9 tests) | `cd frontend && npm test` | the paging auto-answer gate (every required condition is individually necessary; a generic `Call-Info` is never enough) and the microphone error wording |
| Browser end-to-end (18 tests) | `./scripts/test-e2e.sh` | two real Chromium instances act as extensions 1001 and 1002 against the live stack, over HTTPS/WSS through Nginx to Asterisk; see below |
| Stack runtime | `./scripts/test-stack.sh` (`--quick` skips restarts) | compose validity, service status and health, HTTPS, backend `/health`, PostgreSQL readiness, AMI connectivity, authentication, RBAC, audit records, Asterisk version, `pjsip show endpoints`, `dialplan show 700@default`, required modules, WebSocket configuration and the `wss://…/ws` upgrade, security headers; then **restarts Asterisk and measures that the backend reconnects AMI within 10 s**, and restarts PostgreSQL to prove persistence. Exits non-zero if any check fails |
| Outages seen by real browsers | `./scripts/test-resilience.sh` | stops the backend, then Asterisk, while two real browsers (an administrator and an operator) watch: "Cannot reach the server" banner and a refused page when the backend is down, the banner clearing by itself afterwards, "telephony disconnected" banner for the administrator and state **Unknown** (not guessed) when Asterisk is down, paging switched off with a reason, and the browser softphone re-registering on its own when Asterisk returns. Also asserts that the backend shuts down gracefully while browsers are connected. Interrupts the stack for about a minute each time: run it on a development or test stack |
| Windows SIP phone (70 unit + 48 end-to-end) | `cd "SIP Phone/src/SipPhone.Tests" && dotnet test`; `"SIP Phone/test-sipphone.sh"` | the phone engine as `1001-phone` and `1002-phone` against the real Asterisk and, for paging, the real backend: bad password, unreachable server, OPTIONS keep-alive, echo audio, two-way audio by tone analysis, no auto-answer on normal calls, mute/hold/DTMF, decline, cancel, invalid number, direct paging refused, real page auto-answered one-way, single-use and group-specific grant. Uses tones instead of a sound card; details in `SIP Phone/README.md` |
| Backup and restore | `./scripts/test-backup-restore.sh` (drives `backup.sh` and `restore.sh`) | creates a marker user, backs up, creates a second marker, restores, and checks the first is back and the second is gone; also checks that a tampered archive is rejected before anything is changed, the safety backup exists, and login, `/health` and the paging dialplan work afterwards. Restarts frontend, backend and Asterisk: run it on a development or test stack |

## What the browser tests prove (and how)

Chromium is started with fake audio devices: the 1001 browser's "microphone" plays a pure **440 Hz** tone and the 1002
browser's plays **880 Hz**. The tests then analyse the **decoded remote WebRTC audio** with an `AnalyserNode` (Goertzel
amplitude at 440/880 Hz) and read RTP counters from `RTCPeerConnection.getStats()`. So assertions are statements about audio,
not about signalling:

- Normal call 1001→1002 and 1002→1001: the INVITE has no paging headers; the callee is **not** auto-answered (still
  ringing after 3.5 s); after a manual answer each side hears only the *other* side's tone.
- 1001→600 echo: the caller hears its own 440 Hz tone and nothing else.
- Page All / Office / Warehouse: the recipient answers with no interaction, the INVITE it received over the WebSocket carries
  `X-Paging-Call: true`, `Call-Info …;answer-after=0`, `P-Asserted-Identity` and `From: <sip:700@…>`; the recipient hears
  the operator's tone; **the operator hears neither the recipient's tone nor itself while RTP is flowing** (one-way); a
  second page is refused while one is live; ending the page returns both dashboards to Online.
- Dialling 700 directly (SIP credentials but no backend grant) is refused by Asterisk and nobody is paged.
- The read-only `user` role sees live status but has no softphone and no page buttons, and every restricted API call returns 403.
- HTTPS verifies against the generated LAN CA once the CA is in the browser's trust store, and fails without it.
- Dashboards show Offline → Online → In-Call → Paging → Online in real time.
- Click-to-call (`/api/originate`) rings, connects with audio both ways, and `/api/hangup` ends it.
- The session cookie is invisible to JavaScript and nothing is stored in `localStorage`/`sessionStorage`.

The suite also drives the administrator pages (create / edit / disable / delete a user, the protected last administrator, audit filters, system status), microphone problems (denied, missing, busy, refused: a clear message each time and the button usable again) and the "browser blocked audio playback" banner with its recovery.

The harness waits for a quiet system before starting (stale calls from a crashed browser are cleaned up by Asterisk's
30 s media timeout) and creates and removes its own `e2e.*` users. Do not run two instances at once.

### What these tests cannot prove

- That a **human** hears clear, correctly leveled audio through real speakers and microphones.
- Behaviour of Firefox, Safari, mobile browsers, or Windows/macOS trust-store installation.
- Behaviour of **physical SIP phones**.
- Reachability from **other machines on a real LAN**, and the host firewall rules. The test browsers run in a container on
  the compose network.

## MANUAL REQUIRED

These must be run by a person with the hardware. Record the result in `TRACKER.md` (acceptance test 30 and the notes).

### M1. Physical SIP phone (acceptance test 30)

Prerequisites: a phone on the LAN, the server on a Linux host, section 9 of DEPLOYMENT.md applied.

1. Register the phone as `1001-phone` with `EXT_1001_PHONE_PASSWORD`. Confirm `pjsip show contacts` lists it and the
   dashboard shows 1001 **Online** with "Phone" highlighted.
2. Browser (1002) → dial 1001: the phone **and** the 1001 browser ring; answer on the phone; speak both ways; hang up from each side in turn.
3. Phone → dial 1002: the 1002 browser rings and is **not** auto-answered; answer; two-way audio; hang up.
4. Phone → dial 600: you hear your own voice back.
5. Page: from the 1002 browser press **Page Office** (target 1001). Run `pjsip set logger on` and capture the INVITE sent to the
   phone: confirm `Call-Info: …;answer-after=0` and `X-Paging-Call: true`. Does the phone answer by itself and play the audio?
   If not, record **DEVICE LIMITATION** with the model and firmware, and check the phone's auto-answer / intercom settings.
6. Normal calls must remain manual-answer on the phone.

### M2. Other browsers and operating systems

For Firefox, Safari and a Windows or macOS client: install `LAN_CA.crt` as described in DEPLOYMENT.md, open the site, click
**Enable microphone and audio**, confirm registration, and repeat a normal call, the echo test and a page between two
different machines. Record any autoplay or permission differences.

### M3. Real LAN validation on a Linux host

With two PCs (and ideally a phone) on the LAN: apply the firewall ruleset, then confirm calls and pages work between them
and that ports 5038, 8088, 5432 and 3000 are **not** reachable from the LAN (`nmap -p 3000,5038,5432,8088 SERVER_IP` from a
client shows them filtered/closed). Confirm 443, 80, 5060/udp and the RTP range are reachable only from the LAN.

### M5. Windows SIP phone program on a real LAN PC

The engine is verified against the PBX (see the table above) and the program was started and inspected on the development PC,
but it could not be run against the PBX from there (Docker Desktop's host network is inside the VM) and no sound card path was
exercised. On a PC in `LAN_SUBNET`, with a headset: build or copy `SIP Phone.exe`, enter the settings (`SIP Phone/README.md`),
allow the Windows Firewall prompt on private networks, then confirm: registers (green), **Echo test (600)** returns your voice,
a call from a browser rings and can be answered with sound both ways, mute/hold work, and a page from the dashboard is
answered by itself and heard (and the microphone is not sent). Record the Windows version and headset.

### M4. Listening check

Place a call and a page with real headsets/speakers and judge audibility, echo and delay. Automated tests verify that the
correct audio arrives, not that it sounds good.

## Testing a second copy of the stack

Every script honours `COMPOSE_PROJECT_NAME` (default `communications-stack`). To prove that a fresh clone deploys, clone the repository elsewhere, run `scripts/init-env.sh` and `scripts/generate-certs.sh`, stop the stack you are using (the host ports are shared), then run `COMPOSE_PROJECT_NAME=fresh docker compose up -d --build` and the test scripts with the same variable set. This was done for the delivered version and it exposed two packaging defects that were then fixed (see TRACKER.md).

## Running everything

```bash
docker compose up -d --build
./scripts/test-backend.sh
(cd frontend && npm ci && npm test)
./scripts/test-e2e.sh
./scripts/test-stack.sh
./scripts/test-backup-restore.sh   # development/test stack only
./scripts/test-resilience.sh       # development/test stack only
```

## Test-environment notes

- **RTP port 10080 must stay out of the RTP range.** Chromium and Firefox refuse to send to it (restricted "bad port"), so a call whose media lands there signals fine but has no audio. The default range is 10100-10300 and the Asterisk container refuses to start with a range that contains a browser-restricted port. This was the root cause of the intermittent failures seen earlier in the browser tests.
- `scripts/test-e2e.sh` joins the compose network and maps the server hostname to the Nginx container, so it runs the same
  way on Windows, macOS and Linux. It expects `ICE_PERMIT` to cover the compose network (see DEPLOYMENT.md section 12).
- The login rate limiter applies to the test users like any others: repeated failed logins for the *same* username lock it
  out for the window. The E2E suite therefore uses throw-away usernames for its failed-login check.
