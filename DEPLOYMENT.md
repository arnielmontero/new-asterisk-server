# Deployment guide

This stack is for a trusted LAN. Do not expose any of it to the Internet.

## 1. Requirements

- A **Linux host with a fixed LAN IP** is the supported production target. Asterisk runs with `network_mode: host`, so
  the host's own interfaces carry SIP, RTP and the AMI/WebSocket ports.
  (Docker Desktop on Windows/macOS works for development, but "host" there is the Docker VM; see section 12.)
- Docker Engine 24+ with Compose v2, `openssl`, `bash`, `curl`, `python3`.
- About 2 GB RAM and 3 GB disk (the Asterisk image is built from source on first `up`; allow 10-15 minutes and internet
  access for that build only. Runtime needs no Internet).
- The browsers must be able to reach the server on TCP 443 and UDP 10100-10300.

## 2. Install

```bash
git clone <this repository> && cd <repository>
./scripts/init-env.sh            # creates .env with random passwords and secrets (mode 600)
$EDITOR .env                     # set SERVER_IP, SERVER_HOSTNAME, LAN_SUBNET (section 3)
./scripts/generate-certs.sh      # certificates (section 4)
docker compose up -d --build
docker compose ps                # wait until all four are "healthy"
```

Open `https://<SERVER_HOSTNAME>/` and sign in as `admin` with the `ADMIN_PASSWORD` from `.env`.

**Admin bootstrap behaviour:** on the first start the backend creates the user `admin` from `ADMIN_PASSWORD`
(at least 12 characters, not trivial; startup fails with a clear message otherwise). On every later start an existing
`admin` is left untouched, so changing `ADMIN_PASSWORD` in `.env` afterwards does *not* change the password: change it in
the Users page. The password is never written to the logs.

## 3. Environment (`.env`)

`.env` is git-ignored and must never be committed. `.env.example` documents every variable. The important ones:

| Variable | Meaning |
|---|---|
| `SERVER_IP`, `SERVER_HOSTNAME` | the server's LAN IP and DNS name; both become SANs of the HTTPS certificate |
| `LAN_SUBNET` | trusted LAN subnet (CIDR): the only network physical phones may register from |
| `ICE_PERMIT` | networks whose Asterisk addresses are offered to clients for media (default `LAN_SUBNET`, comma-separated). Keep it narrow: see below |
| `PROXY_PERMIT` | source network of the Nginx container as Asterisk sees it (default `172.16.0.0/12`, i.e. Docker bridges) |
| `AMI_PERMIT` | networks allowed to log in to AMI besides loopback (default Docker bridges) |
| `ASTERISK_HOST` | where the `frontend` and `backend` containers reach Asterisk (default `host.docker.internal`) |
| `RTP_START`, `RTP_END` | UDP media port range (default 10100-10300). Must not contain UDP 10080: browsers refuse to send to it, so calls landing there have no audio (the container refuses to start with such a range) |
| `EXT_1001_PASSWORD`, `EXT_1002_PASSWORD`, `EXT_1001_PHONE_PASSWORD`, `EXT_1002_PHONE_PASSWORD` | **Optional, used once.** Extensions are now created and managed in the web UI with generated credentials. On the first start after upgrading from the fixed-extension version these give the two original extensions (1001, 1002) their existing passwords, so phones that are already set up keep registering. Afterwards changing them in `.env` has no effect: use the Extensions page |
| `CDR_RETENTION_DAYS` | delete call records older than this many days (default `0` = keep forever) |
| `AMI_USER`, `AMI_PASS`, `AMI_PORT` | the dedicated AMI account used by the backend |
| `POSTGRES_*`, `JWT_SECRET`, `ADMIN_PASSWORD` | database and application secrets |

**`ASTERISK_HOST`:** the compose file maps `host.docker.internal` to the Docker host via `extra_hosts: host-gateway`,
which works on Linux. If you prefer, set it to the server's LAN IP instead. Whatever you choose must be reachable from the
Docker bridge network, and `AMI_PERMIT`/`PROXY_PERMIT` must cover the source address Asterisk sees.

**`ICE_PERMIT` matters.** Asterisk offers every address of the host as a media (ICE) candidate but keeps only the first
16 it finds, in no particular order. On a Docker host with many bridge interfaces, an unrestricted list occasionally drops
the one address clients can reach and the call connects with no audio. Set `ICE_PERMIT` to the LAN subnet(s) your clients
are on (the default).

## 4. Certificates and the local CA

`./scripts/generate-certs.sh` creates:

| File | Purpose |
|---|---|
| `certs/LAN_CA.crt`, `certs/LAN_CA.key` | your private certificate authority (10 years). Install the `.crt` on clients; keep the `.key` secret |
| `certs/nginx.crt`, `certs/nginx.key` | HTTPS/WSS server certificate signed by the CA (825 days), SANs `DNS:SERVER_HOSTNAME` and `IP:SERVER_IP` |
| `asterisk/keys/asterisk_dtls.pem`, `.key` | a **separate** self-signed certificate for DTLS-SRTP media (browsers verify it by SDP fingerprint). Never the Nginx key |

The script refuses to overwrite existing material (use `--force` to regenerate; every client must then trust the new CA),
sets key files to mode 600, verifies the certificate chain, SANs and key/certificate match, and everything it creates is
git-ignored. Restart `frontend` and `asterisk` after regenerating. Renew the Nginx certificate before it expires by
re-running with `--force` (or by regenerating only after backing up the CA).

### Installing `LAN_CA.crt` on clients

Browsers use a **secure context** only over trusted HTTPS, and microphone access requires it.

- **Windows (all browsers except Firefox):** `Import-Certificate -FilePath .\LAN_CA.crt -CertStoreLocation Cert:\LocalMachine\Root`
  in an elevated PowerShell, or double-click the file → Install Certificate → Local Machine → *Trusted Root Certification Authorities*. Restart the browser.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain LAN_CA.crt`.
- **Linux (system store):** `sudo cp LAN_CA.crt /usr/local/share/ca-certificates/lan-ca.crt && sudo update-ca-certificates`.
  Chrome/Chromium on Linux use the NSS database: `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n lan-ca -i LAN_CA.crt`.
- **Firefox (all platforms):** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import (tick "Trust to identify websites"), or set `security.enterprise_roots.enabled` to `true` to use the OS store.
- **Android / iOS:** install it as a CA certificate / profile (iOS: also enable it under Settings → General → About → Certificate Trust Settings).
- **Physical SIP phones:** not needed. They use plain SIP/UDP with RTP and no TLS, so they do not validate any certificate.

## 5. Hostname, DNS and IP access

Clients must reach the server by name or IP, and the certificate must list what they use:

- **Router/DHCP DNS or a local DNS server (best):** add an A record `SERVER_HOSTNAME -> SERVER_IP`.
- **Hosts file** on each client: `192.168.1.100  communications.local`
  (Windows: `C:\Windows\System32\drivers\etc\hosts`; Linux/macOS: `/etc/hosts`).
- **mDNS:** `.local` names resolve automatically only where Bonjour/Avahi is present; Windows may not resolve them, so do
  not rely on it. A name such as `comms.lan` avoids the `.local` special case.
- **Direct IP:** `https://<SERVER_IP>/` works because the IP is also a certificate SAN.

The browser's SIP client derives the WebSocket address from the page it was loaded from (`wss://<same host>/ws`), so
nothing is hardcoded to a machine name.

## 6. Firewall (LAN only)

| Port | Protocol | Who may connect | Purpose |
|---|---|---|---|
| 443 | TCP | LAN | HTTPS, REST, Socket.IO, `wss://…/ws` |
| 80 | TCP | LAN | redirect to HTTPS |
| 5060 | UDP | LAN | SIP for physical phones |
| 10100-10300 | UDP | LAN | RTP media (browsers and phones) |
| 8088 | TCP | **Docker bridge networks only** | Asterisk HTTP/WebSocket (Nginx -> Asterisk). Not for the LAN |
| 5038 | TCP | **Docker bridge networks / loopback only** | AMI (backend -> Asterisk). Never the LAN or Internet |
| 5432 | TCP | nobody | PostgreSQL is not published; the backend reaches it as `database:5432` on the internal network |
| 3000 | TCP | nobody | the backend is not published; only Nginx reaches it |

Asterisk's ports are bound on the host, so the **host firewall** is what protects 8088 and 5038 (they listen on
0.0.0.0; the AMI user additionally has a source ACL). Example `nftables` ruleset for LAN `192.168.1.0/24`:

```
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    ip protocol icmp accept
    ip saddr 192.168.1.0/24 tcp dport { 22, 80, 443 } accept
    ip saddr 192.168.1.0/24 udp dport 5060 accept
    ip saddr 192.168.1.0/24 udp dport 10100-10300 accept
    ip saddr 172.16.0.0/12 tcp dport { 5038, 8088 } accept   # Docker bridges -> Asterisk (backend, nginx)
  }
}
```

Ports 80/443 are *published by Docker* (NAT), which bypasses the `input` chain and `ufw`. Restrict them in `DOCKER-USER`:

```
iptables -I DOCKER-USER -i eth0 ! -s 192.168.1.0/24 -p tcp -m conntrack --ctorigdstport 443 -j DROP
iptables -I DOCKER-USER -i eth0 ! -s 192.168.1.0/24 -p tcp -m conntrack --ctorigdstport 80  -j DROP
```

Never forward any of these ports from your router to the Internet.

## 7. Extensions, users and credentials

1. Sign in as `admin` → **Extensions** → *Add extension*. Choose a 3-6 digit number and a name; leave the browser
   softphone and/or physical phone ticked. Tick *May place outbound calls* only for extensions that may call outside numbers.
   The SIP credentials are generated and shown once on creation; open them again any time with **Credentials** (each view is
   audited). *New phone password* replaces a secret immediately.
2. **Users** → create a user per person with a role (`operator` or `admin` to call and page; `user` for read-only) and, for
   people who use the browser softphone, assign **one** extension (an extension can belong to one user).
3. The browser fetches the SIP credentials of *its own* extension from the backend after login; users never type or see
   the SIP password. A physical phone or the Windows SIP phone uses the *phone* credentials (username `<number>-phone`).
4. Deleting an extension unassigns its user and removes it from paging groups; it is refused while an inbound route or trunk
   default still sends calls to it.

**Upgrading from the fixed 1001/1002 version:** nothing to do. On the first start the migration creates the two extensions and
the three paging groups, the backend gives them their `.env` credentials, and Asterisk loads the generated files. The
Asterisk container needs the new `pbx_generated` volume (declared in `docker-compose.yml`): `docker compose up -d --build`.

## 7a. Trunks, phone numbers and routes

Outside calls need a **trunk**: where this system sends calls to and receives them from. Add one under **Trunks**:

| You have | Choose | Fill in |
|---|---|---|
| A SIP provider account (username + password) | *SIP provider*, *Registration* | server (e.g. `sip.provider.com`), username, password. The system registers by itself; the status shows **ONLINE** when the provider accepts it, or *Registration rejected* with the reason |
| A provider or carrier that trusts your public IP | *SIP provider*, *IP address* | server, and any extra IPs they call from |
| Another PBX (FreePBX, 3CX, another Asterisk) | *Another PBX*, *IP address* | the other PBX's address; create a matching trunk on the other side pointing at this server |
| A GSM or analog (FXO) gateway | *Gateway*, *IP address* | the gateway's LAN address; set the gateway to send/receive SIP to this server |

Then **Routes**:

- *Inbound*: enter the number your provider sends (the DID, exactly as it appears), pick the trunk (or all) and the extension it
  should ring. Add a `*` route (or the trunk's *default*) to catch everything else; with neither, unknown numbers are rejected.
- *Outbound*: pick a template (e.g. *National*: dial `9` + 10 digits, remove the `9`), choose the trunks in the order to try
  them, and make sure the extensions that may use it have *May place outbound calls* ticked. The route **order** decides which
  of two overlapping routes wins.

Firewall: the provider's addresses must be reachable on UDP/TCP 5060 and the RTP range both ways (see section 6). Calls
from a trunk can only ever reach inbound routes: they cannot dial extensions, paging groups or other trunks.

Passwords must be at least 12 characters (not trivial, not containing the username).

## 8. Browser setup

Supported: current Chrome/Edge, Firefox and Safari. Each time the dashboard is opened an operator clicks
**Enable microphone and audio** and allows the microphone for the site. The SIP client then registers (header chip
"SIP registered (1001)"). Without HTTPS and a trusted CA the button explains that the origin is not secure.

Known browser limits: autoplay rules can block audio until the page has been interacted with (a banner offers a click to
enable sound); a tab that is closed or crashed unregisters (or is detected within about 30 s by the media timeout); only
one browser per extension is registered at a time (a newer registration replaces the older one).

## 9. Physical SIP phones

Register each phone as its own endpoint:

| Setting | Value |
|---|---|
| SIP server | the server's LAN IP, port **5060**, transport **UDP** |
| User / Register name / Auth ID | `1001-phone` (or `1002-phone`) |
| Password | `EXT_1001_PHONE_PASSWORD` (or `EXT_1002_PHONE_PASSWORD`) |
| Display name / caller ID | Office / Warehouse (the PBX sets the caller ID to 1001/1002) |
| Codecs | G.711 µ-law (PCMU) and A-law (PCMA); no encryption, no ICE |
| Phone's network | inside `LAN_SUBNET`, otherwise registration is refused by the endpoint ACL |

Dialling 1001/1002 rings the browser and the phone together. **Paging to phones:** each page INVITE carries
`Call-Info: <sip:host>;answer-after=0` and `X-Paging-Call: true`. Auto-answer on a phone depends on the model and its
"auto answer by Call-Info / intercom" setting, and is **not** standardised: verify it per model with a SIP trace
(`pjsip set logger on`). A phone that does not support it will simply ring (normal calling is unaffected); record that as
a device limitation. Physical-phone behaviour has not been tested in this repository: see [TESTING.md](TESTING.md).

A PC can use the same profile with the Windows program in [SIP Phone/](SIP%20Phone/README.md): it registers as `1001-phone` /
`1002-phone` over UDP exactly as above, answers the PBX's OPTIONS keep-alive and auto-answers pages (Call-Info `answer-after=0`
plus `X-Paging-Call: true` from 700-702). Like every phone it must be inside `LAN_SUBNET`.

## 10. Paging operation

Operators with an extension see **Page All / Page Office / Page Warehouse**. Press a button, speak, press **End page**.
The targets answer automatically and hear you; they cannot reply. A second page cannot start while one is live (admins
can force-end it). The audit log records the request, the start, the end (with duration) and every failure.

## 11. Backup, restore and upgrades

```bash
./scripts/backup.sh                       # -> backups/comms-backup-<UTC timestamp>.tar.gz (mode 600)
BACKUP_PASSPHRASE=... ./scripts/backup.sh # same, encrypted (.tar.gz.enc)
./scripts/backup.sh --include-env         # also stores .env (every secret): protect it accordingly
./scripts/restore.sh backups/<file>       # validates, takes a safety backup, asks you to type "restore"
```

**Included:** the PostgreSQL database (users, audit log), `asterisk/config`, Asterisk's persistent data volume, the TLS
and DTLS certificates **and private keys**, a manifest and SHA-256 checksums. **Excluded:** `.env` (unless asked), logs,
Docker images, `node_modules`, previous backups. The archive is verified after it is written (gzip, checksums,
`pg_restore --list`).

**Restore:** validates the archive (integrity, checksums, expected entries only, no path escapes), refuses to run without
confirmation, takes a safety backup of the live state, stops frontend/backend/asterisk, restores the database in one
transaction, restores config, certificates (with permissions) and the Asterisk volume, restarts everything and checks
health, the frontend and the user count. Test a restore on a non-production copy before relying on it.

Upgrades: `git pull`, review `.env.example` for new variables, then `docker compose up -d --build`. Migrations run
automatically, are versioned and checksummed, and never edit applied history.

## 12. Docker Desktop (development only)

Host networking binds inside Docker Desktop's Linux VM, not on the PC's LAN address, and `host.docker.internal` points at
Windows, not at that VM. For local development set `ASTERISK_HOST` to the VM-reachable bridge gateway (for example
`172.17.0.1`), `LAN_SUBNET` to the VM's subnet (shown by `docker run --rm --network host alpine ip addr`), and `ICE_PERMIT`
to that subnet plus the compose network. Phones or browsers on *other* devices cannot reach such a stack; use a Linux host
for any real LAN validation. A local web server already bound to port 80 on the PC (for example Laragon) will shadow
Docker's port 80.

## 13. Logs, health checks and troubleshooting

```bash
docker compose ps                       # state and health of the four services
docker compose logs -f backend          # structured JSON logs (secrets are redacted)
docker compose logs -f asterisk         # console log
docker compose logs frontend            # Nginx access/error log
docker compose logs database            # PostgreSQL log
docker compose restart <service>
curl -sk https://SERVER/api/health      # {"status":"ok","checks":{"database":"ok","ami":"connected"}}
```

Asterisk (run on the host: `docker exec communications-stack-asterisk-1 asterisk -C /run/asterisk/etc/asterisk.conf -rx "<cmd>"`):

```
core show version          pjsip show endpoints       pjsip show contacts
pjsip show transports      dialplan show 700@default  http show status
pjsip set logger on        # SIP trace -> /var/log/asterisk/full.log ; turn off with "pjsip set logger off"
core show channels         manager show settings
```

`full.log` also records the dialplan execution (verbose 3). It grows with usage; rotate or truncate it as part of normal
host maintenance.

How to tell what is failing:

| Symptom | Check |
|---|---|
| Browser warns about the certificate / no microphone prompt | **TLS**: the CA is not installed on that client, or the URL host is not in the certificate SANs. `openssl s_client -connect SERVER:443 -servername HOST` and compare |
| Dashboard works, SIP chip stays "registering/NOT registered" | **WebSocket**: `curl` the upgrade (see `scripts/test-stack.sh`), `http show status`, Nginx logs; then **SIP registration**: `pjsip show endpoints/contacts`, `pjsip set logger on` |
| Registration rejected (401/403) | **Authentication**: wrong `EXT_*` password in `.env` vs what Asterisk was started with (restart `asterisk` after edits); security events in `docker compose logs asterisk` |
| Call connects but there is no audio, or only one way | **RTP/ICE**: UDP 10100-10300 blocked, or `ICE_PERMIT` does not cover the client's network. In the browser, `chrome://webrtc-internals` shows the ICE state and candidate pairs |
| Dashboard says "Telephony DISCONNECTED", states Unknown, API 503 | **AMI**: `docker compose logs backend` (login failed? ACL?), `AMI_PERMIT`, `manager show settings`. The backend reconnects on its own |
| Backend unhealthy, "database down" | **PostgreSQL**: `docker compose logs database`, `pg_isready` |
| "Enable microphone" fails | **Browser permission**: denied for the site, no device, or not a secure origin |
| Physical phone registers but does not auto-answer pages | **Phone compatibility**: capture the INVITE and compare with the phone's auto-answer rules (section 9) |
| A page seems stuck | an admin can use *Force end page*; Asterisk also ends it after 5 minutes or 30 s without media |
