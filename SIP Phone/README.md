# SIP Phone (Windows dialer)

A small Windows softphone for the LAN Communications & Intercom Stack. It registers with the stack's Asterisk server
the same way a physical IP phone does (the "physical phone" profile in [DEPLOYMENT.md](../DEPLOYMENT.md) section 9), so
a PC with a headset can take the place of a desk phone.

- **Registers** as `1001-phone` or `1002-phone` (SIP over UDP, port 5060, digest authentication).
- **Calls** the other extension and the **echo test (600)**; **receives** calls (ring, answer, decline).
- **Auto-answers pages** from the dashboard (700 All, 701 Office, 702 Warehouse), listen-only, exactly when the
  browser would: the caller is a paging group **and** `X-Paging-Call: true` **and** `Call-Info: ...;answer-after=0`.
- Mute, hold, DTMF keypad, volume, microphone/speaker choice, call history, live SIP log.
- One file: `dist\SIP Phone.exe` (about 70 MB, includes the .NET runtime, nothing to install).

It does **not** place pages itself. The PBX only accepts a page that the dashboard has authorised first (the backend
checks the user's login and role and writes a single-use grant), so dialling 700-702 from this phone is refused by
design. Paging is started from the dashboard; this phone receives it.

## Folder layout

```
SIP Phone/
  dist/SIP Phone.exe        the program (built by build.ps1; not committed to git, see "Build")
  build.ps1, build.cmd      unit tests + single-file publish
  test-sipphone.sh          end-to-end test of the phone engine against the running stack
  tools/make-icon.ps1       regenerates the icon
  src/SipPhone.Core         the SIP phone engine (registration, calls, paging gate, audio plumbing)
  src/SipPhone              the Windows application (WinForms, NAudio for the sound card)
  src/SipPhone.Tests        unit tests (70)
  src/SipPhone.SelfTest     the end-to-end test program used by test-sipphone.sh
```

## What you need from the administrator

| Setting | Value |
|---|---|
| Server address | the server's LAN IP (or `communications.local` if your DNS/hosts file resolves it) |
| Port | 5060 (UDP) |
| SIP user | `1001-phone` or `1002-phone` |
| Password | `EXT_1001_PHONE_PASSWORD` / `EXT_1002_PHONE_PASSWORD` from the server's `.env` |

The PC must be **inside `LAN_SUBNET`** (the `.env` setting). The phone endpoints refuse every other address, so a PC
on another subnet or behind a VPN cannot register even with the right password.

## First start

1. Run `SIP Phone.exe`. The settings window opens on first run.
2. Enter the four values above, choose your headset (or leave "System default"), press **Save and connect**.
3. The dot in the top-left turns green and the window says **Ready**. Amber means it is still registering; red
   shows the reason (wrong password, server not reachable, ...) and the phone keeps retrying by itself.
4. Windows asks whether to allow the program on the network: allow it on **private** networks. (It needs UDP for SIP
   and for the audio the PBX sends back.)
5. Press **Echo test (600)** and speak: you hear yourself a moment later. That proves registration, the microphone,
   the speaker and two-way audio.

Settings are stored in `%APPDATA%\SIP Phone\settings.json`. The password is encrypted with Windows DPAPI for your
Windows account: it is never written as plain text and another Windows user cannot read it. Set the environment
variable `SIPPHONE_DATA_DIR` to keep the settings somewhere else (portable use). Only one copy can run at a time (two
copies would fight over the same registration).

## Using it

| To do this | Do this |
|---|---|
| Call | type the number (or click keys) and press **Call** or Enter; or use the quick buttons |
| Answer / decline | **Answer** / **Decline** when it rings (the window comes to the front and flashes in the taskbar) |
| Send keypad tones | click the keypad or just type digits, `*` and `#` during the call |
| Mute / hold | **Mute** / **Hold** (not available during a page) |
| Redial | double-click an entry in the history |
| See what the phone sent and received | **SIP log** (Copy / Save). Useful when asking for help |

During a page the window shows **PAGE - listen only**: the microphone is never sent and cannot be unmuted, and
**Stop listening** ends it.

## How it behaves (and why)

- **Only the PBX can ring it.** An INVITE from any other address is refused with 403, so another PC on the LAN cannot
  make this phone open its speaker by faking paging headers. (This is in the code; the automated tests cannot spoof a source address, so it is not covered by them.)
- **Keep-alive.** The PBX sends an OPTIONS request every 30 s to every phone; the phone answers it. Without that
  answer Asterisk would mark the phone *Unavailable* and stop ringing it.
- **Re-registration.** The registration is refreshed before it expires. If the server is down the phone retries
  (5 s, 10 s, 20 s, 40 s, then every 60 s); after a wrong password it retries every 5 minutes so it does not hammer
  the server.
- **Audio.** G.711 µ-law and A-law at 20 ms, RFC 4733 DTMF, plain RTP (no encryption), exactly what the endpoint
  allows. No echo cancellation: use a headset, not open speakers.
- **One call at a time.** A second call while one is active is refused ("busy" for incoming).

## Build from source

Needs the .NET 8 SDK (not needed to *run* the exe).

```
powershell -ExecutionPolicy Bypass -File build.ps1          (or double-click build.cmd)
```

This runs the 70 unit tests and then writes `dist\SIP Phone.exe` and `dist\SIP Phone.exe.sha256`. The exe is not
committed to git (70 MB); every checkout rebuilds it in about a minute.

SIPSorcery is pinned to 10.0.17. Earlier versions have known high-severity denial-of-service advisories
(GHSA-28gm-jrmw-xx93 fixed in 10.0.9, GHSA-jwjp-4649-v8jp fixed in 10.0.14).

## Tests

```
cd src\SipPhone.Tests && dotnet test          70 unit tests: paging rule, dial strings, settings, header lookup, G.711 round trip
./test-sipphone.sh                            48 end-to-end checks against the running stack (needs Docker, run from Git Bash)
```

`test-sipphone.sh` runs the same engine code (as a Linux build, with tones instead of a sound card) as the two phones
`1001-phone` and `1002-phone` against the real Asterisk, and, for paging, through the real backend API. It checks:
a wrong password is refused with a clear reason; an unreachable server is reported; registration survives the PBX's
OPTIONS keep-alive; echo test returns the 440 Hz tone; a call rings the other phone and is **not** auto-answered;
both sides hear only the other side's tone; mute, hold, DTMF; remote hang-up; decline, caller cancel (missed call),
invalid number (404), garbage input, a second call refused; dialling 700-702 directly is refused; and a real page
(authorised by the backend) is auto-answered, shown as a page, heard one-way (the operator hears nothing back), cannot
be un-muted, ends when the operator stops, and the grant is single-use and group-specific.

The test runs in a Linux container with host networking next to Asterisk because, on Docker Desktop for Windows,
Asterisk's host network lives inside the Docker VM and the Windows host cannot send SIP to it. On a Linux server the
Windows program itself can be pointed at the server from any LAN PC.

## Known limitations (genuine ones)

- **The Windows program has not been run against the PBX from this development PC** for the reason above. What was
  verified: the engine against the real PBX (48 checks), and the Windows program itself starting, showing the first-run
  and main windows and reporting an unreachable server correctly. **Not verified:** the sound card path (microphone and
  speaker via NAudio), the Windows Firewall prompt behaviour and a call from a real LAN PC. These are listed as
  MANUAL REQUIRED in [TESTING.md](../TESTING.md) (M5).
- No echo cancellation, no call transfer, no video, IPv4 only, one call at a time.
- Registers over UDP only (that is what the phone endpoints allow); no TLS/SRTP, same as the physical-phone profile.
- Windows 10/11 64-bit only.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Red, "No answer from ..." | wrong address/port, firewall between the PC and server, or the PC is not on the same LAN |
| Red, "refused the login" | wrong SIP user or password (use the `...-phone` user, not `1001`) |
| Green but a call is refused 403 | the PC's address is outside `LAN_SUBNET`, or you dialled 700-702 (paging is dashboard-only) |
| Calls connect but there is no sound | Windows Firewall blocked the program (allow it on private networks); wrong speaker/microphone in Settings |
| Others cannot reach the phone | another copy is registered as the same user (the PBX keeps one contact per phone) |
| Nothing helps | open **SIP log**, reproduce the problem, press Save and send the file |
