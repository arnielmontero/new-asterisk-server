# Completion report (task §77)

Figures below are the results recorded in [TRACKER.md](TRACKER.md) from the runs made while building and verifying the stack. Nothing here is estimated. Per-test evidence is in the acceptance table in TRACKER.md.

## PROJECT STATUS

**PASS, with one MANUAL REQUIRED item.** Acceptance tests 1–29 are PASS and test 30 (physical SIP phone) is MANUAL REQUIRED, so this is not "100% complete". Test 5 (CA trust) is PASS on Chromium/Linux only; other operating systems and browsers are MANUAL REQUIRED, and firewall behaviour on a real LAN is not verified. See MANUAL TESTS.

## IMPLEMENTED

- Asterisk 22 with PJSIP over UDP and WebSocket (WSS), SRTP/DTLS, Opus, extensions 1001/1002, echo test 600, normal calls and live one-way paging (`Page()`)
- Node.js backend: JWT in an HttpOnly cookie, RBAC (administrator / operator / user), user management, append-only audit log, AMI client with reconnect, Socket.IO real-time state, call and paging endpoints, `/health`
- Frontend SPA: dashboard, browser softphone (WebRTC), paging with browser auto-answer gate, user management, audit log and system status pages, error banners
- Nginx with HTTPS (TLS 1.2/1.3), HTTP→HTTPS redirect, `/api`, `/socket.io` and `/ws` proxying, security headers
- PostgreSQL with migrations and a persistent volume
- LAN CA and certificate generation, secrets generation, backup and restore scripts, healthchecks, automated test suites, documentation

## DOCKER

Four services (asterisk, backend, database, frontend), all `healthy` when last observed. Asterisk uses host networking as the spec requires.

## ASTERISK

Pinned **22.11.0** (source SHA256 verified), Debian 12.12-slim pinned by digest, Opus codec binary pinned by version and SHA256.

## BACKEND

Verified. 143 backend tests, run against the stack's real PostgreSQL.

## FRONTEND

Verified. 9 unit tests and 18 browser tests.

## DATABASE

Verified. Data persists across a database restart, migrations are tested fresh, repeated and concurrent, and the audit log is append-only.

## SECURITY

- Same-origin only: no CORS headers are sent, and a cross-origin POST is refused with 403
- JWT checks cover expiry, tampering, wrong audience and `alg=none`
- Login rate limiting and a session cap are in place
- Secrets scan clean: no `.env` value appears in tracked files, git history or container logs
- Keys, certificates, `.env` and backups are git-ignored
- AMI, Asterisk HTTP and PostgreSQL are not exposed; firewall rules are documented (see KNOWN LIMITATIONS)

## AUTOMATED TESTS

All passed on their last recorded runs:

| Suite | Result |
|---|---|
| Backend | 143 / 143 |
| Frontend unit | 9 / 9 |
| Browser end-to-end | 18 / 18 (the earlier 15x15 stability run: 225 / 225) |
| Stack runtime (`test-stack.sh`) | 62 / 62 |
| Backup and restore | 16 / 16 |
| Resilience (backend and Asterisk outages seen by real browsers) | 6 / 6 |

## MANUAL TESTS

- **MANUAL REQUIRED:** test 30, physical SIP phone (steps in TESTING.md M1). No phone was available. The phone endpoints were checked with a software SIP client.
- **MANUAL REQUIRED:** firewall behaviour on a real LAN (TESTING.md M3). The rulesets load without error in a throwaway network namespace, but their effect on a real LAN has not been observed.
- **MANUAL REQUIRED:** CA install on Windows, macOS, Firefox and mobile (acceptance test 5 was verified on Chromium/Linux only).
- **MANUAL REQUIRED:** subjective audio quality with real headsets.
- No manual test has been run and failed.

## TELEPHONY

Two real Chromium instances register as 1001 and 1002 over `wss://…/ws` (REGISTER answered 200 OK).

## AUDIO

Two-way audio verified by decoding the received tones: with a normal call, 1001 hears only 880 Hz and 1002 hears only 440 Hz.

## PAGING

One-way paging verified: the caller's audio reaches the paged party and nothing returns.

## AUTO-ANSWER

Paging calls auto-answer in the browser only when every gate condition holds, and each condition is individually tested. Normal calls verified not to auto-answer.

## PHYSICAL SIP

MANUAL REQUIRED (see MANUAL TESTS).

## BACKUP/RESTORE

Verified. Backup integrity is checked, a restore returns the original data, and a tampered archive is rejected before anything changes.

## KNOWN LIMITATIONS

- Debian apt packages in the Asterisk image are not version-pinned (no snapshot repository).
- On Docker Desktop for Windows, host networking binds inside the Docker VM, not the Windows LAN IP. LAN validation from other devices needs a Linux host.
- Two earlier "connected but silent" browser failures were not root-caused. They did not recur in the 15 runs after the RTP-port fix. See TRACKER.md, Decisions & open items.
- File modes cannot be enforced or verified on an NTFS host. They were checked inside the container instead.
