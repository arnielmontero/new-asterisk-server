path = "/mnt/data/Production-LAN-Communications-Intercom-Final-Build-Prompt.txt"

prompt = r'''SYSTEM BUILD PROMPT
PRODUCTION LAN COMMUNICATIONS & INTERCOM STACK
VERSION: FINAL 1.0

ROLE
Act as a Principal Telephony, WebRTC, Linux, Docker, Security, Backend, Frontend, and DevOps Architect.

MISSION
Build the complete production-ready self-hosted LAN Communications & Intercom Stack described below.

This is an implementation task, not a design-only task.

You must:

1. Create the complete project.
2. Create all source code.
3. Create all Dockerfiles.
4. Create Docker Compose configuration.
5. Create all Asterisk configuration.
6. Create database schema and migrations.
7. Create backend APIs.
8. Create frontend UI.
9. Create WebRTC/SIP functionality.
10. Create paging functionality.
11. Create authentication and RBAC.
12. Create audit logging.
13. Create certificate-generation tooling.
14. Create backup and restore tooling.
15. Create automated tests.
16. Create deployment documentation.
17. Build and run the system.
18. Execute all possible automated tests.
19. Execute all possible runtime validation.
20. Fix errors discovered during implementation and testing.
21. Do not stop at placeholders, examples, pseudocode, mock implementations, or incomplete modules.
22. Do not declare the system complete until all achievable acceptance tests pass.

Do not ask unnecessary implementation questions.
Do not ask me to choose between implementation alternatives when the requirements below already define the required behavior.
Use the requirements below as authoritative.
If a technical detail is version-dependent, verify it against the exact pinned version and implement the correct version-specific solution.
If something cannot be automatically tested in the available environment, mark it MANUAL REQUIRED and explain exactly how it must be tested. Never fabricate a successful result.

============================================================

1. # CORE OBJECTIVE

Build a completely self-hosted LAN-only communications system providing:

- Browser-based WebRTC softphones.
- SIP/PJSIP support for physical LAN SIP/IP phones.
- Extension-to-extension calling.
- Echo test extension.
- One-way live paging/intercom broadcast.
- Browser dashboard.
- User authentication.
- Role-based access control.
- Real-time extension presence/state.
- Administrative user management.
- Audit logging.
- Asterisk telephony control through AMI.
- PostgreSQL persistence.
- Dockerized deployment.
- LAN HTTPS/WSS.
- Local certificate authority.
- Backup and restore.
- Health checks.
- Automatic AMI reconnect.
- Production-oriented security and validation.

The system must operate without cloud telephony services.

No Twilio.
No hosted PBX.
No cloud SIP provider.
No external database.
No external authentication provider.
No dependency on a cloud API for core telephony.

Internet access may be used during image/package installation or development if required, but runtime functionality must remain self-hosted on the LAN.

============================================================ 2. TARGET CLIENTS
============================================================

Supported clients:

A. Browser WebRTC client
B. Physical SIP/IP phone using PJSIP UDP

Browser requirements:

- HTTPS.
- WSS SIP signaling.
- WebRTC audio.
- Microphone access.
- Speaker/remote-audio playback.
- SIP registration.
- Incoming call handling.
- Outgoing calls.
- Paging auto-answer handling.

Physical SIP phone requirements:

- SIP UDP registration.
- Extension authentication.
- Normal two-way calls.
- Paging behavior where the device supports SIP auto-answer headers.

Do not assume every physical SIP phone supports the same auto-answer mechanism.
Document that vendor-specific behavior may differ.
The acceptance test must use at least one real SIP/IP phone if one is available in the environment.

============================================================ 3. FIXED EXTENSIONS
============================================================

Implement these extensions:

1001 = Office
1002 = Warehouse

600 = Echo Test

700 = Page All
701 = Page Office
702 = Page Warehouse

The extension numbers must not be arbitrarily changed by the implementation.

Extension credentials must come from environment variables/secrets and must never be hardcoded into source control.

Required variables include:

EXT_1001_PASSWORD
EXT_1002_PASSWORD

If additional extension metadata is required, keep it configuration-driven.

============================================================ 4. PAGING GROUPS
============================================================

Paging groups:

700:

- All paging targets
- 1001
- 1002

701:

- Office
- 1001

702:

- Warehouse
- 1002

Paging must be one-way.

The paging initiator transmits audio.
Recipients receive the audio.
Recipients must not be able to speak back through the paging session.

Normal extension-to-extension calls must remain fully two-way.

If the initiating extension is also a member of the target paging group, prevent self-calling/self-page behavior where necessary.

============================================================ 5. CRITICAL PAGING AUDIO-SOURCE REQUIREMENT
============================================================

The paging implementation MUST define exactly where the live paging microphone audio originates.

Do NOT implement a backend AMI call to 700/701/702 that creates a page with no human media source.

Asterisk Page() requires an active media channel/source for live paging.

Required architecture:

Dashboard Page button
|
v
Backend authorization/audit
|
v
Authenticated user's registered extension/browser SIP client
|
v
Paging extension/context
|
v
Asterisk Page()
|
+----> target 1001
|
+----> target 1002

The implementation may use the frontend SIP/WebRTC client to establish the paging call after backend authorization, or an equivalent correctly implemented Asterisk/AMI flow, but the final behavior MUST provide the actual operator microphone audio to Asterisk.

The backend must not pretend that an AMI Originate to a page extension is itself a microphone source.

Preferred behavior for the browser dashboard:

1. Logged-in operator has a registered SIP extension.
2. Operator clicks Page All, Page Office, or Page Warehouse.
3. Backend validates JWT and role.
4. Backend validates the requested paging group.
5. Backend writes an audit log.
6. Frontend initiates the authorized SIP paging call using the operator's WebRTC microphone.
7. Asterisk executes the version-correct paging application/dialplan.
8. Target devices receive the paging INVITE.
9. Valid paging targets auto-answer.
10. Operator microphone audio is broadcast.
11. Recipients cannot transmit audio back.
12. Page ends cleanly.
13. Dashboard receives the paging state in real time.

If the implementation chooses a different technically correct flow, it must still satisfy all behavior above.

Do not leave the audio-source behavior undefined.

============================================================ 6. DOCKER ARCHITECTURE
============================================================

Use Docker Compose.

Services:

1. asterisk
2. backend
3. frontend
4. database

All services must use:

restart: unless-stopped

All applicable services must have explicit Docker healthchecks.

Do not use floating latest tags.

Pin base images and important dependency versions.

The Asterisk version MUST be one exact pinned 22.x LTS patch version.

Do not write:

- Asterisk 20/22
- latest
- dynamically selected Asterisk versions

Select one exact supported Asterisk 22.x LTS patch version and pin it in the Dockerfile/build configuration.

Record the exact version in the project documentation.

If compiling Asterisk from Debian, pin:

- Debian base image version/digest where practical.
- Asterisk exact source version.
- Asterisk source checksum.
- Required build dependencies.

Node.js must also use one exact pinned LTS version rather than a floating latest tag.

PostgreSQL must use PostgreSQL 16 as required, with an exact pinned image tag/digest where practical.

============================================================ 7. ASTERISK CONTAINER
============================================================

Asterisk must use host networking.

Do not expose Asterisk through Docker bridge port mappings.

Mount:

./asterisk/config -> /etc/asterisk
./asterisk/keys -> /etc/asterisk/keys
asterisk persistent data -> /var/lib/asterisk
asterisk logs -> /var/log/asterisk

Use appropriate ownership and permissions.

Do not run the whole container unnecessarily privileged.

Asterisk must provide:

- PJSIP
- SIP UDP
- WebRTC
- RTP
- DTLS-SRTP
- WebSocket SIP transport
- AMI
- Page()
- Echo()
- Dial()
- Required codec support

Ensure required Asterisk modules are installed and loaded.

Verify at runtime that required modules are actually available.

============================================================ 8. ASTERISK VERSION PINNING
============================================================

Use one exact Asterisk 22.x LTS patch release.

The implementation must record the selected exact version in:

- Dockerfile
- README/DEPLOYMENT.md
- test output where appropriate

Verify version-specific syntax for:

- PJSIP
- WebRTC
- Page()
- pre-dial handlers
- PJSIP_HEADER()
- AMI
- HTTP/WebSocket
- DTLS configuration

Do not blindly reuse configuration examples written for another Asterisk release.

============================================================ 9. ASTERISK HTTP/WEBSOCKET ARCHITECTURE
============================================================

Asterisk HTTP/WebSocket is an internal plain WS endpoint.

Architecture:

Browser
|
| WSS :443
v
Nginx
|
| plain WS :8088
v
Asterisk

Nginx terminates browser-facing TLS.

Asterisk does NOT need to terminate browser-facing WSS/TLS.

Configure Asterisk HTTP server on:

0.0.0.0:8088

Expose the WebSocket endpoint required by the selected SIP client, normally:

/ws

Verify the exact endpoint behavior against the selected Asterisk version.

Do not expose port 8088 publicly.
It should be reachable only as required by the local Docker/LAN architecture.

============================================================ 10. ASTERISK PJSIP TRANSPORTS
============================================================

Provide:

- UDP transport on port 5060.
- WebSocket transport for WebRTC clients.

Configure appropriate PJSIP endpoint/auth/AOR sections.

Disable anonymous/guest SIP access.

Restrict SIP access to the intended LAN where practical.

Use:

- authentication
- endpoint identification
- appropriate contexts
- codecs
- NAT-related settings suitable for LAN
- direct_media=no where required to keep Asterisk in the media path
- rtp_symmetric=yes where appropriate
- force_rport=yes
- rewrite_contact=yes where appropriate

Do not create an insecure anonymous SIP PBX.

============================================================ 11. WEBRTC CONFIGURATION
============================================================

Browser WebRTC endpoints must use:

webrtc=yes
media_encryption=dtls
dtls_verify=fingerprint
dtls_setup=actpass
avpf=yes
icesupport=yes
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

Use:

opus
ulaw
alaw

Verify codec availability in the selected Asterisk build.

If Opus requires an additional package/module/build dependency, install and validate it.

Configure appropriate RTP settings.

Create rtp.conf with an explicit RTP port range.

Do not leave RTP configuration ambiguous.

============================================================ 12. DTLS-SRTP CERTIFICATES
============================================================

Generate a dedicated Asterisk DTLS-SRTP certificate/key pair.

Example paths:

/etc/asterisk/keys/asterisk_dtls.pem
/etc/asterisk/keys/asterisk_dtls.key

The exact certificate/key format MUST match the requirements of the pinned Asterisk version.

Do not assume the Nginx HTTPS certificate can be reused.

Do not reuse the Nginx private key unless explicitly verified as supported and secure.

Use appropriate file ownership and permissions.

Validate that Asterisk starts successfully and can use the DTLS material.

============================================================ 13. NGINX
============================================================

Frontend container:

Nginx.

Expose:

80:80
443:443

Nginx responsibilities:

- HTTPS TLS termination.
- HTTP to HTTPS redirect.
- Serve frontend static application.
- Proxy /api/\* to backend.
- Proxy /socket.io/\* to backend.
- Proxy /ws to Asterisk WebSocket.
- Configure WebSocket upgrade correctly.

For the Asterisk WS proxy use:

HTTP/1.1
Upgrade header
Connection header

The final Nginx configuration must correctly support:

wss://SERVER_HOST/ws

to:

ws://ASTERISK_HOST:8088/ws

Do not expose backend port directly to the LAN unless explicitly required.

Use secure response headers where compatible.

============================================================ 14. NGINX CONFIGURATION VARIABLES
============================================================

Do not hardcode environment-specific Asterisk host addresses.

Use a reliable configuration mechanism.

ASTERISK_HOST must be configurable.

If using:

host.docker.internal

ensure Linux Docker provides the required host-gateway mapping.

For example, implement an appropriate Docker Compose host-gateway configuration when needed.

Alternatively use the explicit LAN server IP.

Do not create a configuration that only works accidentally on one developer machine.

The Nginx startup/configuration mechanism must correctly resolve the configured Asterisk destination.

============================================================ 15. TLS / LOCAL PKI
============================================================

Create:

./scripts/generate-certs.sh

Generate a local LAN CA:

LAN_CA.crt
LAN_CA.key

Generate an Nginx server certificate signed by the LAN CA.

The certificate SANs must be generated from:

SERVER_IP
SERVER_HOSTNAME

Example SANs may include:

IP:192.168.1.100
DNS:communications.local

Do not assume an example IP is the actual server IP.

Use the configured environment values.

Only include localhost SANs if actually useful.

Generate a separate Asterisk DTLS certificate as described earlier.

Protect private keys.

Use appropriate file permissions.

Document how to install LAN_CA.crt into:

- Windows trusted root certificates
- browsers where necessary
- Linux clients where applicable
- physical SIP devices if they require certificate trust for any feature

Browser microphone access requires a secure origin, so HTTPS must work correctly.

============================================================ 16. DOMAIN / HOSTNAME
============================================================

Support:

SERVER_HOSTNAME

Example:

communications.local

But do not assume that .local DNS will automatically resolve on every LAN device.

Deployment documentation must explain one of:

- local DNS
- router DNS
- hosts file
- mDNS if appropriate
- direct server IP

The system must also work using the configured LAN IP where certificate SANs permit it.

============================================================ 17. POSTGRESQL
============================================================

Use PostgreSQL 16.

Persistent volume:

pgdata

Healthcheck:

pg_isready -U ${POSTGRES_USER}

Database must not be directly exposed to the LAN.

Backend connects using the Docker service name:

database:5432

Implement connection retry.

Implement idempotent database migrations.

Do not rely on manual database creation steps.

============================================================ 18. DATABASE SCHEMA
============================================================

Minimum tables:

users

Fields:

id
username
password_hash
role
created_at
updated_at
is_active

audit_logs

Fields:

id
timestamp
username
action
target
ip_address
status
details where useful

Use proper indexes.

Use timestamps consistently.

Use foreign keys where appropriate.

Do not store plaintext passwords.

Use Argon2id or bcrypt with a secure cost factor.

============================================================ 19. ADMIN BOOTSTRAP
============================================================

Create a default administrator securely from:

ADMIN_PASSWORD

Do not hardcode an administrator password.

Do not print the administrator password in logs.

Seed the administrator idempotently.

If the administrator already exists, do not overwrite the password unexpectedly on every restart.

Document the bootstrap behavior.

============================================================ 20. AUTHENTICATION
============================================================

Implement JWT authentication.

Required endpoint:

POST /api/auth/login

Validate:

username
password

Return an authenticated JWT on success.

Use:

- strong JWT secret from environment
- expiration
- issuer/audience where practical
- appropriate signing algorithm
- rejection of expired tokens

Do not use an empty/default JWT secret.

Rate-limit login attempts.

Do not expose password hashes through APIs.

============================================================ 21. JWT STORAGE
============================================================

Use secure token handling.

Prefer:

- HttpOnly
- Secure
- SameSite

cookie-based authentication where compatible with the architecture.

If bearer tokens are returned and used directly by the SPA, do not store long-lived tokens in localStorage unnecessarily.

Use short-lived access tokens or another secure strategy.

The implementation must document the chosen JWT handling mechanism.

============================================================ 22. RBAC
============================================================

Roles:

admin
operator
user

Permissions:

ADMIN:

- full system access
- dashboard
- extension status
- originate calls
- paging
- user management
- audit log access
- system status

OPERATOR:

- dashboard
- extension status
- originate calls
- paging

USER:

- read-only extension status
- no paging
- no originate
- no user management

Enforce authorization on the backend.

Do not rely only on hiding frontend buttons.

============================================================ 23. USER MANAGEMENT
============================================================

Because administrators have user-management permission, implement the required backend functionality.

Minimum:

GET /api/users
POST /api/users
PATCH /api/users/:id
DELETE /api/users/:id

Allow:

- username
- role
- active/inactive
- password reset/change by authorized admin

Prevent an administrator from accidentally removing the last active administrator unless explicitly handled safely.

Audit user-management actions.

============================================================ 24. BACKEND
============================================================

Use:

Node.js
Express
PostgreSQL

Implement clean modular architecture.

Suggested modules:

auth
users
extensions
paging
calls
audit
ami
database
socket
health
validation

Do not create one huge backend file.

Use environment configuration.

Do not hardcode secrets.

============================================================ 25. AMI
============================================================

Backend communicates with Asterisk through AMI.

AMI host:

ASTERISK_HOST

AMI port:

AMI_PORT

Default AMI port:

5038

Credentials:

AMI_USER
AMI_PASS

Implement:

- connection
- authentication
- reconnect
- exponential backoff
- event handling
- connection state
- clean shutdown

If Asterisk restarts, backend must reconnect automatically.

Target recovery:

AMI reconnect within 10 seconds under normal local-LAN conditions.

============================================================ 26. AMI SECURITY
============================================================

AMI must not be broadly exposed.

Asterisk may bind AMI to:

0.0.0.0:5038

only if protected by host firewall and network restrictions.

Prefer restricting access to the backend host/network.

Do not expose AMI to the Internet.

Use a dedicated AMI account.

The requested privileges are:

system
call
log
verbose
command
agent
user
config
originate

However, apply least privilege where the exact implementation permits.

Do not grant unnecessary privileges merely because they were listed if they are not required by the final implementation, but document any reduction.

============================================================ 27. EXTENSION STATE
============================================================

Implement real-time extension state.

States:

Online
Offline
In-Call
Paging

Do not generate fake state.

Backend must derive state from actual Asterisk/AMI events where possible.

Handle relevant events such as:

ContactStatus
DeviceStateChange
Newchannel
Hangup
DialBegin
DialEnd
BridgeEnter
BridgeLeave

Use the exact event names/fields available from the pinned Asterisk version.

Normalize them into application-level extension states.

============================================================ 28. SOCKET.IO
============================================================

Use Socket.IO for backend-to-frontend real-time dashboard updates.

Required:

/socket.io/

Authenticate Socket.IO connections.

Do not expose extension state to unauthenticated users.

Broadcast events such as:

extension.status.changed
paging.started
paging.ended
call.started
call.ended
ami.connected
ami.disconnected

Keep the event format documented.

============================================================ 29. HEALTH ENDPOINTS
============================================================

Backend:

GET /health

Health response should report meaningful status such as:

database
ami
application

Separate liveness/readiness behavior if appropriate.

A service returning HTTP 200 while AMI is disconnected must not falsely represent the telephony subsystem as healthy.

============================================================ 30. CALL API
============================================================

Required:

POST /api/originate

Authenticated.

Allowed only for admin/operator.

Input must be strictly validated.

Do not allow arbitrary AMI commands.

Do not allow arbitrary destination injection.

Allow only configured extensions.

Example:

1001 -> 1002
1002 -> 1001

Backend should use the correct AMI Originate mechanism.

Audit every successful and failed call-origination request.

============================================================ 31. PAGING API
============================================================

Required:

POST /api/page

Allowed:

admin
operator

User role must be rejected.

Allowed targets:

700
701
702

Do not accept arbitrary dialplan destinations.

Validate requested group.

Write an audit log.

The endpoint must coordinate with the actual operator SIP/WebRTC media source.

Do not implement a fake backend-only page.

The API must return meaningful status.

Prevent duplicate/concurrent paging where necessary.

============================================================ 32. AUDIT LOGGING
============================================================

Audit at minimum:

login success
login failure
user creation
user modification
user deletion
call originate
paging request
paging success
paging failure
important administrative actions

Include:

timestamp
username
action
target
source IP
status
details when useful

Audit logs must be persistent in PostgreSQL.

Do not allow normal users to modify audit records through the application.

============================================================ 33. ASTERISK DIALPLAN
============================================================

Implement:

1001 -> 1002 direct call
1002 -> 1001 direct call

30-second timeout.

600:

Answer
Echo
Hangup

Paging:

700 Page All
701 Page Office
702 Page Warehouse

Use the exact version-correct Asterisk syntax.

Do not blindly use this example:

Page(PJSIP/1001&PJSIP/1002, d, b(sub-add-paging-headers^s^1))

Instead:

1. Verify the exact Page() syntax for the pinned Asterisk release.
2. Verify option meanings.
3. Verify pre-dial handler syntax.
4. Verify PJSIP_HEADER() syntax.
5. Verify actual outgoing SIP INVITEs.
6. Verify the paging media behavior.
7. Verify one-way behavior.

Implement the correct equivalent.

============================================================ 34. PAGING SIP HEADERS
============================================================

The paging implementation must add appropriate headers to outgoing paging INVITEs.

Desired logical markers:

Call-Info:
auto-answer / answer-after=0

X-Paging-Call:
true

P-Asserted-Identity:
Paging System <sip:paging@communications.local>

However, these are requirements for behavior, not permission to use invalid syntax.

Verify exact header syntax/escaping against the pinned Asterisk version.

The custom X-Paging-Call marker must be included.

The browser must not auto-answer every call containing a generic Call-Info header.

============================================================ 35. BROWSER AUTO-ANSWER
============================================================

Use one pinned SIP client library/version.

Choose one:

SIP.js
OR
JsSIP

Do not leave the implementation dependent on an unspecified library version.

Implement the code against the exact selected version.

Browser paging auto-answer must require ALL relevant conditions:

1. Incoming SIP INVITE.
2. Caller is a known paging extension/group:
   700
   701
   702
3. X-Paging-Call is exactly true.
4. Call-Info contains the expected auto-answer marker.
5. Request is otherwise valid/authenticated.

Conceptually:

callerId = session.remoteIdentity.uri.user

isKnownPagingGroup =
callerId in [700,701,702]

hasPagingHeader =
X-Paging-Call == true

hasAutoAnswerHeader =
Call-Info contains answer-after=0

Only if all required conditions pass:

accept the session automatically.

Do not auto-answer ordinary calls.

Ordinary calls must continue to ring and require normal user interaction.

Verify the exact header-reading API against the selected SIP client version.

============================================================ 36. BROWSER AUDIO
============================================================

Use:

getUserMedia()

for microphone access.

Use a remote audio element with:

autoplay
playsinline

Handle:

audio.play()

Promise rejection.

Browser autoplay policies may prevent audio playback until a user gesture.

Therefore the UI must include a one-time:

Enable Audio / Enable Microphone

interaction during login or dashboard initialization.

The user must grant microphone permission.

After permissions are granted, paging audio should play automatically where browser policy permits.

Do not falsely claim browsers can bypass browser security permissions.

Document this requirement.

============================================================ 37. WEBRTC REGISTRATION
============================================================

Browser client must register using:

WSS

through:

Nginx :443

to:

Asterisk WS :8088

Example logical SIP URI:

sip:1001@communications.local

The implementation must derive the correct host dynamically where practical.

Do not hardcode a developer's machine hostname.

Use extension credentials securely.

Show registration state in the UI.

============================================================ 38. FRONTEND
============================================================

Build a responsive SPA.

Use:

HTML
CSS
JavaScript

and a lightweight appropriate frontend structure.

Use SIP.js or JsSIP as selected above.

Required pages/components:

Login
Dashboard
Extension status
Softphone
Paging controls
Call controls
User management
Audit logs
System status

Do not create decorative pages that have no real functionality.

============================================================ 39. DASHBOARD
============================================================

Display:

1001 Office
1002 Warehouse

States:

Online
Offline
In-Call
Paging

Controls:

Call
Hangup where applicable
Page All
Page Office
Page Warehouse

Paging buttons:

Admin: enabled
Operator: enabled
User: disabled/hidden

But backend authorization remains mandatory.

Display AMI/backend connection status for administrators.

============================================================ 40. SOFTPHONE
============================================================

Required functionality:

- SIP registration
- call another extension
- incoming call
- answer
- reject
- hangup
- microphone
- remote audio
- call state
- paging reception
- paging transmission
- echo test

Do not implement fake call controls.

============================================================ 41. ECHO TEST
============================================================

Extension 600:

Answer
Echo application
Hangup

Verify actual audio.

Manual test:

Browser 1001 -> 600

Speak.

Confirm returned audio is the user's own voice.

============================================================ 42. PHYSICAL SIP PHONE
============================================================

Support physical SIP/IP phones over UDP/PJSIP.

Manual acceptance test where a physical phone is available:

1. Register physical phone as a configured extension.
2. Confirm registration.
3. Browser -> physical phone.
4. Physical phone -> browser.
5. Confirm two-way audio.
6. Test normal ringing/manual answer.
7. Test hangup.
8. Test paging where the physical phone supports SIP auto-answer.
9. Document vendor-specific limitations if auto-answer is unsupported.

If no physical phone is available during automated development:

Mark physical-phone tests:

MANUAL REQUIRED

Do not mark them PASS.

============================================================ 43. SIP SECURITY
============================================================

Configure:

allow_guest=no

Do not allow anonymous calls.

Restrict SIP access to LAN networks where appropriate.

Use strong extension passwords.

Do not log SIP credentials.

Document firewall requirements.

At minimum document required LAN ports:

TCP 443
TCP 80 if redirect is used
UDP 5060
UDP RTP range
TCP/WS 8088 only where internally required
TCP 5038 only between backend and Asterisk

Do not expose PostgreSQL publicly.

Do not expose AMI publicly.

Do not expose Asterisk HTTP WS publicly.

============================================================ 44. RTP
============================================================

Create explicit RTP configuration.

Use a defined UDP RTP range.

Document firewall requirements.

Ensure Docker host networking allows RTP correctly.

Verify actual media packets/audio during testing where practical.

Do not rely only on SIP signaling success to declare audio working.

============================================================ 45. FIREWALL
============================================================

Provide deployment documentation with example firewall rules for a LAN-only deployment.

Clearly state:

- trusted LAN subnet
- HTTPS allowed from LAN
- SIP UDP allowed from LAN
- RTP range allowed from LAN
- AMI restricted to backend
- Asterisk WS restricted to local proxy path
- PostgreSQL restricted to Docker network

Do not provide rules that expose AMI/database to the Internet.

============================================================ 46. INPUT VALIDATION
============================================================

Validate all API inputs.

Reject:

- unknown roles
- invalid extension
- arbitrary dial strings
- arbitrary AMI commands
- malformed usernames
- weak/invalid passwords where policy applies
- invalid paging group
- oversized request bodies
- unexpected fields where appropriate

Use a proper validation library.

Return safe error messages.

Never leak stack traces or secrets to the client.

============================================================ 47. SECURITY HEADERS
============================================================

Nginx should provide appropriate security headers such as:

Content-Security-Policy where compatible
X-Content-Type-Options
Referrer-Policy
frame restrictions
appropriate Permissions-Policy

Do not break microphone/WebRTC functionality.

============================================================ 48. CORS
============================================================

The preferred deployment is same-origin:

https://SERVER_HOST

Frontend -> /api
Frontend -> /socket.io
Frontend -> /ws

Avoid broad CORS.

If CORS is necessary, allow only configured trusted origins.

Do not use:

Access-Control-Allow-Origin: \*

for authenticated production endpoints unless there is a documented unavoidable reason.

============================================================ 49. LOGGING
============================================================

Use structured application logging where practical.

Never log:

- passwords
- JWT secrets
- AMI passwords
- SIP passwords
- private keys

Log:

- startup
- shutdown
- database connection
- AMI connection
- AMI reconnect
- authentication failures
- call operations
- paging operations
- unexpected errors

============================================================ 50. DATABASE MIGRATIONS
============================================================

Create migrations.

Migrations must be:

- versioned
- repeat-safe
- deterministic
- suitable for fresh deployment

Startup must not corrupt an existing database.

Test:

fresh database
existing database
restart

============================================================ 51. BACKUP
============================================================

Create:

./scripts/backup.sh

Backup:

- PostgreSQL data
- Asterisk configuration
- Asterisk relevant persistent data
- TLS certificates
- DTLS certificates

Do not casually expose secrets.

Use secure permissions.

Document what is included.

Document what is excluded.

Create timestamped backups.

Validate backup archive integrity.

============================================================ 52. RESTORE
============================================================

Create:

./scripts/restore.sh

Requirements:

- validate backup path
- stop relevant services safely
- restore PostgreSQL
- restore Asterisk configuration
- restore certificates
- validate permissions
- restart services
- execute health checks

Do not silently overwrite a live installation without safeguards.

Document restore procedure.

Test restore on a development/test environment.

============================================================ 53. CERTIFICATE GENERATION
============================================================

Create:

scripts/generate-certs.sh

It must:

1. Generate LAN CA.
2. Generate Nginx key.
3. Generate Nginx CSR.
4. Sign Nginx certificate.
5. Include SERVER_IP and SERVER_HOSTNAME SANs.
6. Generate Asterisk DTLS certificate/key in the exact required format.
7. Set secure permissions.
8. Be repeat-safe or clearly refuse unsafe overwrite.

Do not commit generated private keys to source control.

============================================================ 54. PROJECT FILE STRUCTURE
============================================================

Create a clear project structure similar to:

communications-stack/
|
+-- docker-compose.yml
+-- .env.example
+-- .gitignore
+-- README.md
+-- DEPLOYMENT.md
+-- TESTING.md
|
+-- asterisk/
| +-- Dockerfile
| +-- config/
| | +-- asterisk.conf
| | +-- modules.conf
| | +-- http.conf
| | +-- pjsip.conf
| | +-- extensions.conf
| | +-- manager.conf
| | +-- rtp.conf
| | +-- logger.conf
| +-- keys/
|
+-- backend/
| +-- Dockerfile
| +-- package.json
| +-- src/
| +-- migrations/
| +-- tests/
|
+-- frontend/
| +-- Dockerfile
| +-- nginx.conf
| +-- src/
| +-- package.json
| +-- tests/
|
+-- scripts/
| +-- generate-certs.sh
| +-- backup.sh
| +-- restore.sh
| +-- test-stack.sh

The final structure may differ if technically necessary, but every required function must have a real implementation.

============================================================ 55. ENVIRONMENT VARIABLES
============================================================

Provide:

.env.example

Minimum variables:

POSTGRES_DB
POSTGRES_USER
POSTGRES_PASSWORD

JWT_SECRET

ADMIN_PASSWORD

AMI_USER
AMI_PASS
AMI_PORT

ASTERISK_HOST

SERVER_IP
SERVER_HOSTNAME

EXT_1001_PASSWORD
EXT_1002_PASSWORD

Add any other required variables.

Do not hardcode secrets.

.env must be ignored by Git.

============================================================ 56. DOCKER HEALTHCHECKS
============================================================

Asterisk:

Verify Asterisk process/CLI is responsive.

Possible validation:

asterisk -rx "core show uptime"

Use the correct method for the final image.

Backend:

GET /health

Database:

pg_isready

Frontend:

HTTPS/Nginx response validation.

Healthchecks must actually detect broken services.

============================================================ 57. STARTUP ORDER
============================================================

Use Docker Compose health conditions where useful.

Backend must wait for PostgreSQL readiness.

Backend must tolerate Asterisk becoming temporarily unavailable.

Frontend must tolerate backend restart.

Do not assume startup order alone guarantees readiness.

============================================================ 58. AUTOMATIC RECONNECTION
============================================================

Backend AMI connection must:

- detect disconnect
- reconnect automatically
- use exponential backoff
- reset backoff after successful connection
- expose connection state
- not crash the application

Acceptance:

Restart Asterisk.

Backend reconnects within 10 seconds under normal local conditions.

Verify actual connection state.

============================================================ 59. AUTOMATED TEST SUITE
============================================================

Create automated tests for:

Authentication:

- valid login
- invalid login
- expired/invalid token

RBAC:

- admin allowed
- operator allowed
- user denied
- unauthenticated denied

Users:

- create
- update
- deactivate/delete
- unauthorized access denied

Calls:

- valid originate
- invalid destination rejected
- unauthorized originate rejected
- audit log created

Paging:

- valid group
- invalid group rejected
- unauthorized paging rejected
- audit log created

Database:

- migrations
- persistence
- constraints

Backend:

- health
- AMI state
- reconnect behavior where automatable

Asterisk:

- endpoint configuration
- dialplan loading
- required modules
- transports

============================================================ 60. STACK TEST SCRIPT
============================================================

Create:

scripts/test-stack.sh

It must perform as many real validations as possible.

Minimum:

1. docker compose config
2. service status
3. container health
4. HTTPS availability
5. backend /health
6. PostgreSQL readiness
7. AMI connectivity
8. authentication
9. RBAC
10. audit logging
11. Asterisk version
12. pjsip show endpoints
13. dialplan show 700@default
14. WebSocket configuration
15. restart Asterisk
16. verify backend AMI reconnect
17. verify frontend availability

Use nonzero exit codes when required tests fail.

============================================================ 61. REAL TELEPHONY TESTING
============================================================

Automated configuration tests are NOT sufficient.

Where the environment permits, actually test:

A. Browser 1001 registration.
B. Browser 1002 registration.
C. 1001 -> 1002 two-way audio.
D. 1002 -> 1001 two-way audio.
E. 1001 -> 600 echo.
F. Page All.
G. Page Office.
H. Page Warehouse.
I. Normal calls remain manual-answer.
J. Paging auto-answer works only for paging.
K. Paging is one-way.
L. Page terminates correctly.
M. Physical SIP phone behavior where hardware is available.

If actual audio cannot be tested automatically:

MANUAL REQUIRED

Do not report PASS.

============================================================ 62. PAGING HEADER VALIDATION
============================================================

Do not consider paging complete merely because:

- dialplan loads
- Page() exists
- backend returns 200
- frontend button works

Inspect actual SIP signaling.

Prove that the outgoing paging INVITEs contain the expected paging markers.

Verify:

X-Paging-Call: true

and the expected auto-answer Call-Info behavior.

Verify the actual SIP client receives those headers.

For browser clients, inspect the received SIP INVITE/request object.

For physical phones, use appropriate SIP trace/logging where available.

============================================================ 63. NORMAL CALL VS PAGING BEHAVIOR
============================================================

Normal call:

1001 -> 1002

must:

- ring
- require normal answer
- support two-way audio

Paging:

700/701/702

must:

- be identified as paging
- auto-answer only when the paging conditions are met
- deliver live operator audio
- prevent recipient talk-back

Do not allow paging headers to accidentally make ordinary calls auto-answer.

============================================================ 64. ONE-WAY AUDIO VERIFICATION
============================================================

This must be tested behaviorally.

During paging:

Operator:

- microphone audio reaches recipients.

Recipient:

- microphone audio must not return to operator.

Use actual audio verification where possible.

If necessary, inspect Asterisk channel/bridge/media behavior.

Do not claim one-way paging solely from dialplan text.

============================================================ 65. BROWSER PERMISSION MODEL
============================================================

The browser cannot be forced to grant:

- microphone permission
- speaker permission
- secure-origin permission

The system must provide a clear first-use audio setup flow.

Example:

Login
|
v
Enable Microphone / Audio
|
v
Dashboard
|
v
Ready for calls/paging

After the user grants permission, paging should work with no additional answer interaction for a valid paging INVITE, subject to browser autoplay/security policies.

Document this honestly.

============================================================ 66. PHYSICAL PHONE AUTO-ANSWER
============================================================

SIP auto-answer is not universally standardized across all hardware.

Implement the requested headers.

Test with the actual phone model.

If a phone does not support the required auto-answer behavior:

- do not fake success
- record MANUAL/DEVICE LIMITATION
- document the exact limitation
- keep normal SIP calling functional

============================================================ 67. FRONTEND ERROR HANDLING
============================================================

Display useful errors for:

- login failure
- SIP registration failure
- microphone denied
- audio playback blocked
- call failure
- paging failure
- backend unavailable
- AMI unavailable

Do not expose internal stack traces.

Provide retry/reconnect behavior.

============================================================ 68. SIP REGISTRATION MONITORING
============================================================

The backend/dashboard must distinguish:

- registered
- unavailable
- in-call
- paging

Do not treat the web dashboard being logged in as equivalent to SIP registration.

The UI should clearly show when the SIP/WebRTC client itself is not registered.

============================================================ 69. CLEAN SHUTDOWN
============================================================

Implement graceful shutdown for backend:

- stop accepting new requests
- close Socket.IO
- close AMI
- close database connections

Asterisk should stop cleanly.

Nginx should stop cleanly.

============================================================ 70. SOURCE CONTROL
============================================================

Create:

.gitignore

Never commit:

.env
private keys
generated certificates
database dumps
logs
node_modules
build artifacts
temporary files

Provide safe example configuration.

============================================================ 71. DOCUMENTATION
============================================================

Create:

README.md
DEPLOYMENT.md
TESTING.md

Documentation must include:

- architecture
- requirements
- installation
- environment setup
- certificate generation
- LAN DNS/hosts configuration
- firewall
- Docker commands
- user setup
- extension credentials
- browser setup
- physical SIP phone setup
- paging operation
- backup
- restore
- troubleshooting
- logs
- health checks
- test procedures
- known browser limitations
- known SIP phone auto-answer limitations

============================================================ 72. TROUBLESHOOTING
============================================================

Document commands to inspect:

Docker:

docker compose ps
docker compose logs
docker compose restart

Asterisk:

asterisk -rx "core show version"
asterisk -rx "pjsip show endpoints"
asterisk -rx "pjsip show transports"
asterisk -rx "dialplan show 700@default"
asterisk -rx "http show status"

Backend logs.

Nginx logs.

PostgreSQL logs.

Explain how to determine whether failures are:

- TLS
- WebSocket
- SIP registration
- authentication
- RTP/audio
- AMI
- PostgreSQL
- browser permission
- physical-phone compatibility

============================================================ 73. NO MOCK PRODUCTION PATH
============================================================

Do not use:

- fake extension states
- simulated calls
- fake paging success
- mock AMI responses in production
- fake SIP registration
- fake audio
- placeholder API endpoints
- TODO implementations

Mocks may be used only inside isolated unit tests where appropriate.

Production execution must use the real Asterisk/AMI/PJSIP/WebRTC stack.

============================================================ 74. NO FAKE SUCCESS RULE
============================================================

THIS RULE IS MANDATORY.

Never mark an acceptance test as PASS based solely on:

- configuration inspection
- source-code inspection
- HTTP 200 responses
- container startup
- simulated results
- mocked results

If a test cannot actually be performed:

MARK IT:

MANUAL REQUIRED

Do not fabricate a result.

Do not claim that:

- WebRTC registration works
- SIP registration works
- two-way audio works
- paging works
- SIP auto-answer works
- one-way paging works
- physical SIP phone interoperability works

unless that behavior has actually been verified.

============================================================ 75. ACCEPTANCE TESTS
============================================================

The project is complete only when all applicable acceptance tests pass.

TEST 1:
Docker Compose configuration validates.

TEST 2:
All required containers start.

TEST 3:
All applicable healthchecks pass.

TEST 4:
HTTPS works.

TEST 5:
Browser trusts the generated LAN CA after installation.

TEST 6:
Backend /health reports healthy database and AMI status.

TEST 7:
Administrator login works.

TEST 8:
Invalid login fails.

TEST 9:
RBAC works.

TEST 10:
User management works.

TEST 11:
1001 WebRTC registration works.

TEST 12:
1002 WebRTC registration works.

TEST 13:
1001 -> 1002 rings and supports two-way audio.

TEST 14:
1002 -> 1001 rings and supports two-way audio.

TEST 15:
1001 -> 600 provides real echo audio.

TEST 16:
Page All works.

TEST 17:
Page Office works.

TEST 18:
Page Warehouse works.

TEST 19:
Paging recipients auto-answer only when paging markers are present.

TEST 20:
Normal calls do not auto-answer.

TEST 21:
Paging is one-way.

TEST 22:
Paging terminates cleanly.

TEST 23:
Extension state updates in real time.

TEST 24:
AMI disconnect/reconnect works.

TEST 25:
Audit records are created.

TEST 26:
Invalid call/page destinations are rejected.

TEST 27:
PostgreSQL data persists after restart.

TEST 28:
Backup completes successfully.

TEST 29:
Restore completes successfully in test environment.

TEST 30:
Physical SIP phone tests pass if a physical phone is available.

Any unavailable test must be:

MANUAL REQUIRED

============================================================ 76. FINAL VALIDATION
============================================================

Before declaring completion:

1. Build all images.
2. Start the complete stack.
3. Wait for healthchecks.
4. Run database migrations.
5. Validate Asterisk startup.
6. Validate PJSIP.
7. Validate WebSocket.
8. Validate backend.
9. Validate frontend.
10. Run automated tests.
11. Run test-stack.sh.
12. Perform real telephony tests where possible.
13. Test paging.
14. Test auto-answer.
15. Test normal calls.
16. Test AMI reconnect.
17. Test backup.
18. Test restore.
19. Review logs for errors.
20. Fix all implementation errors.
21. Repeat failed tests.
22. Do not leave known critical errors unresolved.

============================================================ 77. COMPLETION REPORT
============================================================

At the end, provide a concise completion report containing:

PROJECT STATUS:
PASS / BLOCKED

IMPLEMENTED:
List major components.

DOCKER:
Container status.

ASTERISK:
Exact version.

BACKEND:
Status.

FRONTEND:
Status.

DATABASE:
Status.

SECURITY:
Status.

AUTOMATED TESTS:
Passed / Failed.

MANUAL TESTS:
Passed / Failed / MANUAL REQUIRED.

TELEPHONY:
Browser registration status.

AUDIO:
Two-way audio status.

PAGING:
Status.

AUTO-ANSWER:
Status.

PHYSICAL SIP:
Status or MANUAL REQUIRED.

BACKUP/RESTORE:
Status.

KNOWN LIMITATIONS:
Only genuine limitations.

Do not say "100% complete" if an acceptance test is still unverified.

============================================================ 78. IMPLEMENTATION PRIORITY
============================================================

Implement in this order:

PHASE 1:
Repository/project structure and Docker foundation.

PHASE 2:
Asterisk exact pinned build and base configuration.

PHASE 3:
PJSIP UDP and WebRTC transports.

PHASE 4:
Extensions 1001/1002 and echo 600.

PHASE 5:
Backend PostgreSQL/auth/RBAC.

PHASE 6:
AMI integration and real-time state.

PHASE 7:
Frontend dashboard and WebRTC softphone.

PHASE 8:
Normal extension calling.

PHASE 9:
Paging audio-source architecture.

PHASE 10:
Paging groups and headers.

PHASE 11:
Browser paging auto-answer.

PHASE 12:
Physical SIP phone compatibility/testing.

PHASE 13:
TLS/PKI/security hardening.

PHASE 14:
Backup/restore.

PHASE 15:
Automated tests.

PHASE 16:
Real runtime/telephony acceptance testing.

PHASE 17:
Documentation and final cleanup.

Do not skip ahead while earlier foundational phases are broken.

============================================================ 79. IMPORTANT IMPLEMENTATION PRINCIPLES
============================================================

Prefer simple, maintainable solutions.

Do not over-engineer.

Do not introduce unnecessary frameworks.

Do not add cloud services.

Do not add billing/subscription functionality.

Do not add unnecessary microservices.

Keep the system self-contained.

Use environment-driven configuration.

Use secure defaults.

Use deterministic builds.

Pin versions.

Validate runtime behavior.

Test actual telephony.

Fix errors instead of documenting them as success.

============================================================ 80. FINAL DIRECTIVE
============================================================

BUILD THE SYSTEM.

Do not merely explain how to build it.

Do not return only a blueprint.

Do not return pseudocode.

Do not leave placeholders.

Do not leave TODO markers for required functionality.

Create the actual files.

Install/build the required dependencies.

Run Docker Compose.

Run migrations.

Run tests.

Run runtime validation.

Inspect Asterisk.

Inspect SIP/WebSocket behavior.

Verify actual paging signaling.

Verify actual audio where possible.

Fix implementation errors.

Repeat tests after fixes.

If a test requires hardware or human interaction that is unavailable, mark it MANUAL REQUIRED with exact instructions.

Never fabricate test results.

Never claim a telephony feature works solely because the configuration appears correct.

The final result must be a complete, runnable, self-hosted LAN Communications & Intercom Stack with:

- Asterisk
- PJSIP
- WebRTC
- SIP/IP phone support
- Nginx HTTPS/WSS
- Node.js backend
- PostgreSQL
- JWT/RBAC
- AMI
- real-time status
- normal two-way calls
- echo test
- live one-way paging
- browser paging auto-answer
- audit logging
- TLS/PKI
- backup/restore
- healthchecks
- automated testing
- real telephony validation

Do the work from start to finish.

Only report completion after the implementation and validation process is finished.
'''

with open(path, "w", encoding="utf-8") as f:
f.write(prompt)

print(path)
