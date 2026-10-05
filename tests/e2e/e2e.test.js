'use strict';
/*
 * Real-browser acceptance tests against the live stack.
 *
 * Two Chromium instances play the operators of extensions 1001 and 1002. Each one has a
 * fake microphone that plays a different pure tone (440 Hz for 1001, 880 Hz for 1002), so
 * "who hears whom" is measured on the decoded remote audio instead of being assumed.
 * The SIP messages each browser receives over the WSS connection are captured so paging
 * headers are proven on the wire, not inferred from configuration.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, request } = require('playwright');

const BASE = process.env.BASE_URL || 'https://communications.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PASSWORD = 'E2e-Operator-Passw0rd!';
const USERS = {
  office: { username: 'e2e.office', role: 'operator', extension: '1001', tone: 440 },
  warehouse: { username: 'e2e.warehouse', role: 'operator', extension: '1002', tone: 880 },
  viewer: { username: 'e2e.viewer', role: 'user', extension: null },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeTone(file, freq, seconds = 1, rate = 48000, amplitude = 0.5) {
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// --------------------------------------------------------------------------- browsers
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const open = []; // everything to close at the end

async function launchOperator(user) {
  const tone = path.join(tmp, `tone-${user.tone}.wav`);
  writeTone(tone, user.tone);
  const browser = await chromium.launch({ args: [...FLAGS, `--use-file-for-fake-audio-capture=${tone}`] });
  const context = await browser.newContext({ permissions: ['microphone'] });
  // Test-harness only: keep a handle on every RTCPeerConnection so inbound RTP can be counted.
  await context.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function PatchedPeerConnection(...args) {
      const pc = new Original(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Original.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Original);
  });
  const page = await context.newPage();
  const sip = [];
  const problems = [];
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return; // SIP only (Socket.IO uses /socket.io/)
    ws.on('framereceived', (f) => sip.push({ dir: 'in', text: String(f.payload) }));
    ws.on('framesent', (f) => sip.push({ dir: 'out', text: String(f.payload) }));
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  open.push(browser);
  return { user, browser, context, page, sip, problems };
}

async function signIn(op) {
  const { page, user } = op;
  await page.goto(`${BASE}/`);
  await page.fill('#username', user.username);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
}

async function enableAudioAndRegister(op) {
  const { page } = op;
  await page.getByRole('button', { name: 'Enable microphone and audio' }).click();
  await page.waitForFunction(() => /registered \(\d+\)/.test(document.querySelector('#chip-sip')?.textContent || ''), null, { timeout: 25000 });
}

const stateOf = (page, ext) => page.locator(`article[data-extension="${ext}"] .badge`).getAttribute('data-state');
const waitState = (page, ext, state, timeout = 15000) =>
  page.waitForFunction(([e, s]) => document.querySelector(`article[data-extension="${e}"] .badge`)?.getAttribute('data-state') === s, [ext, state], { timeout });
const bannerText = (page) => page.locator('#call-banner').innerText();
const waitBanner = (page, re, timeout = 15000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#call-banner')?.textContent || ''), re.source, { timeout });
const noCall = (page, timeout = 15000) => page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout });

/**
 * Measure what a browser is actually hearing (decoded remote WebRTC audio), not what was signalled.
 * `waitFor` ('a440' | 'a880'): wait up to `maxWait` ms for that tone to appear first (ICE/DTLS can
 * take a moment after the SIP call connects), then keep listening for `ms` more.
 * `packets` is the number of inbound audio RTP packets on the active peer connection, so
 * "heard nothing" can be told apart from "no media path at all".
 */
async function hear(page, opts = {}) {
  const result = await hearRaw(page, opts);
  result.diag = await diagnostics(page);
  return result;
}

async function hearRaw(page, { ms = 1600, waitFor = null, maxWait = 12000 } = {}) {
  return page.evaluate(async ({ ms: duration, waitFor: want, maxWait: limit, present }) => {
    const el = document.getElementById('remote-audio');
    const stream = el && el.srcObject;
    if (!stream || stream.getAudioTracks().length === 0) return { stream: false, a440: 0, a880: 0, rms: 0, packets: 0 };
    const ctx = new AudioContext();
    await ctx.resume();
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const amp = (f) => {
      let re = 0; let im = 0; const w = (2 * Math.PI * f) / ctx.sampleRate;
      for (let i = 0; i < buf.length; i += 1) { re += buf[i] * Math.cos(w * i); im -= buf[i] * Math.sin(w * i); }
      return (2 * Math.hypot(re, im)) / buf.length;
    };
    const best = { a440: 0, a880: 0, rms: 0 };
    const sample = async () => {
      await new Promise((r) => setTimeout(r, 150));
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      best.rms = Math.max(best.rms, Math.sqrt(sum / buf.length));
      best.a440 = Math.max(best.a440, amp(440));
      best.a880 = Math.max(best.a880, amp(880));
    };
    if (want) {
      const deadline = performance.now() + limit;
      while (performance.now() < deadline && best[want] <= present) await sample();
      best.a440 = want === 'a440' ? best.a440 : 0;
      best.a880 = want === 'a880' ? best.a880 : 0;
      best.rms = 0;
    }
    const end = performance.now() + duration;
    while (performance.now() < end) await sample();
    let packets = 0;
    const pc = (window.__pcs || []).filter((p) => p.connectionState !== 'closed').pop();
    if (pc) {
      const stats = await pc.getStats();
      stats.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') packets = Math.max(packets, r.packetsReceived || 0); });
    }
    await ctx.close();
    return { stream: true, ...best, packets };
  }, { ms, waitFor, maxWait, present: 0.08 });
}

/** Snapshot of the media path of the active call (used to explain failures, never to pass a test). */
// Kernel view of the browsers' UDP sockets (this process shares the network namespace with Chromium):
// whether a socket exists for a local port, how much is queued unread, and which process owns it.
function kernelUdp(ports) {
  const want = new Set(ports.map(Number));
  const rows = [];
  for (const file of ['/proc/net/udp', '/proc/net/udp6']) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 13) continue;
      const port = parseInt(f[1].split(':')[1], 16);
      if (!want.has(port)) continue;
      const [tx, rx] = f[4].split(':').map((h) => parseInt(h, 16));
      rows.push({ file: file.split('/').pop(), local: f[1], rxQueue: rx, txQueue: tx, inode: f[9], drops: Number(f[12]) });
    }
  }
  const owners = {};
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target = '';
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && rows.some((r) => r.inode === m[1])) (owners[m[1]] ||= []).push(Number(pid));
    }
  }
  return rows.map((r) => ({ ...r, pids: owners[r.inode] || [] }));
}

async function diagnostics(page) {
  const out = await collectDiagnostics(page);
  const ports = (out.pairs || []).map((p) => /^\S+ [\d.]+:(\d+)\/host ->/.exec(p)?.[1]).filter(Boolean);
  try { out.kernelSockets = kernelUdp([...new Set(ports)]); } catch (e) { out.kernelSockets = String(e); }
  return out;
}

async function collectDiagnostics(page) {
  return page.evaluate(async () => {
    const pc = (window.__pcs || []).filter((p) => p.connectionState !== 'closed').pop();
    const el = document.getElementById('remote-audio');
    const out = { audioEl: el ? { paused: el.paused, muted: el.muted, hasStream: !!el.srcObject, tracks: el.srcObject ? el.srcObject.getAudioTracks().map((t) => ({ muted: t.muted, enabled: t.enabled, state: t.readyState })) : [] } : null };
    if (!pc) return { ...out, pc: null };
    out.pc = { ice: pc.iceConnectionState, dtls: pc.connectionState, signaling: pc.signalingState };
    const stats = await pc.getStats();
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.inbound = { packets: r.packetsReceived, lost: r.packetsLost, bytes: r.bytesReceived, samples: r.totalSamplesReceived, concealed: r.concealedSamples, level: r.audioLevel };
      if (r.type === 'media-source' && r.kind === 'audio') out.mic = { level: r.audioLevel, energy: r.totalAudioEnergy, duration: r.totalSamplesDuration };
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.outbound = { packets: r.packetsSent, bytes: r.bytesSent };
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) out.pair = { local: r.localCandidateId, remote: r.remoteCandidateId, rtt: r.currentRoundTripTime };
    });
    // Every candidate pair Chrome tried and how many of its STUN checks were answered.
    const cands = {};
    stats.forEach((r) => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = `${r.address || r.ip}:${r.port}/${r.candidateType}`; });
    out.pairs = [];
    stats.forEach((r) => {
      if (r.type === 'candidate-pair') out.pairs.push(`${r.state}${r.nominated ? '*' : ''} ${cands[r.localCandidateId]} -> ${cands[r.remoteCandidateId]} req=${r.requestsSent} resp=${r.responsesReceived} reqRecv=${r.requestsReceived}`);
    });
    out.remoteCandidates = Object.values(cands).filter((c, i, a) => a.indexOf(c) === i).length;
    return out;
  });
}

const D = (...heards) => ` DIAG=${JSON.stringify(heards.map((x) => x.diag))}`;
const PRESENT = 0.08;
const ABSENT = 0.02;

const invitesIn = (op, since = 0) => op.sip.slice(since).filter((m) => m.dir === 'in' && /^INVITE sip:/.test(m.text));

// ------------------------------------------------------------------------------- API
let admin;
let api;
async function adminApi() {
  api = await request.newContext({ baseURL: BASE });
  const res = await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } });
  assert.equal(res.status(), 200, 'admin login');
  return api;
}
async function deleteE2eUsers() {
  const { users } = await (await api.get('/api/users')).json();
  for (const u of users.filter((x) => x.username.startsWith('e2e.'))) await api.delete(`/api/users/${u.id}`);
}
async function createUsers() {
  for (const u of Object.values(USERS)) {
    const res = await api.post('/api/users', { data: { username: u.username, password: PASSWORD, role: u.role, extension: u.extension } });
    assert.equal(res.status(), 201, `create ${u.username}: ${await res.text()}`);
  }
}
const audit = async (action) => (await (await api.get(`/api/audit?action=${action}&pageSize=100`)).json()).items;

// ------------------------------------------------------------------------------ tests
let A; // operator of 1001 (tone 440)
let B; // operator of 1002 (tone 880)

// A previous run (or a crashed browser) can leave calls up for a short while: Asterisk drops
// them after the RTP timeout. Wait for a quiet system so every test starts from a known state.
async function waitForQuietStack(timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { extensions } = await (await api.get('/api/extensions')).json();
    const { page } = await (await api.get('/api/page')).json();
    if (!page && extensions.every((e) => e.state === 'Offline')) return;
    await sleep(2000);
  }
  throw new Error('stack did not become idle (stale calls or registrations)');
}

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  admin = await adminApi();
  await deleteE2eUsers();
  await waitForQuietStack();
  await createUsers();
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try { await deleteE2eUsers(); } catch { /* best effort */ }
  await api?.dispose();
});

describe('browser acceptance', { concurrency: false }, () => {
  test('HTTPS is served with a certificate that chains to the generated LAN CA (trusted after CA install)', async () => {
    const browser = await chromium.launch({ args: FLAGS });
    open.push(browser);
    const page = await (await browser.newContext()).newPage();
    const res = await page.goto(`${BASE}/`);
    assert.equal(res.status(), 200);
    assert.equal(new URL(page.url()).protocol, 'https:');
    const sec = await res.securityDetails();
    assert.ok(sec, 'TLS security details present');
    assert.match(sec.issuer, /LAN Communications Root CA/);
    assert.match(sec.protocol, /TLS 1\.[23]/);
    assert.equal(await page.evaluate(() => window.isSecureContext), true, 'secure context => getUserMedia allowed');
    await browser.close();
  });

  test('without the LAN CA the browser refuses the site (proves trust comes from the CA, not from bypassing checks)', async () => {
    const browser = await chromium.launch({ args: FLAGS, env: { ...process.env, HOME: fs.mkdtempSync(path.join(tmp, 'nohome-')) } });
    open.push(browser);
    const page = await (await browser.newContext()).newPage();
    await assert.rejects(page.goto(`${BASE}/`), /ERR_CERT_AUTHORITY_INVALID|net::ERR_CERT/);
    await browser.close();
  });

  test('login: wrong password shows an error; the login page does not leak whether a user exists', async () => {
    const browser = await chromium.launch({ args: FLAGS });
    open.push(browser);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${BASE}/`);
    // A throw-away name for the failed attempt: the login limiter (correctly) locks an account out
    // after repeated failures, and repeated suite runs must not lock out the real test users.
    await page.fill('#username', `e2e.nobody-${Date.now()}`);
    await page.fill('#password', 'definitely-wrong-password');
    await page.click('button[type=submit]');
    await page.waitForSelector('.form-error:not([hidden])');
    assert.match(await page.locator('.form-error').innerText(), /Invalid username or password/);
    // The session cookie is HttpOnly: scripts cannot read it.
    await page.fill('#username', USERS.office.username);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForSelector('text=Enable microphone and audio');
    assert.equal(await page.evaluate(() => document.cookie), '', 'HttpOnly session cookie is invisible to JavaScript');
    assert.equal(await page.evaluate(() => JSON.stringify(Object.keys(localStorage)) + JSON.stringify(Object.keys(sessionStorage))), '[][]', 'no token is kept in web storage');
    await browser.close();
  });

  test('1001 and 1002 register over WSS through Nginx to Asterisk (acceptance tests 11 and 12)', async () => {
    A = await launchOperator(USERS.office);
    B = await launchOperator(USERS.warehouse);
    await signIn(A);
    await enableAudioAndRegister(A);
    await signIn(B);
    await enableAudioAndRegister(B);
    // SIP REGISTER went over the WebSocket and was accepted with 200 OK
    for (const op of [A, B]) {
      assert.ok(op.sip.some((m) => m.dir === 'out' && /^REGISTER sip:/.test(m.text)), 'REGISTER sent over WSS');
      assert.ok(op.sip.some((m) => m.dir === 'in' && /^SIP\/2\.0 200 OK/.test(m.text) && /CSeq: \d+ REGISTER/.test(m.text)), 'REGISTER answered 200 OK');
    }
    // Asterisk agrees: both endpoints have a contact, and dashboards show Online in real time
    await waitState(A.page, '1001', 'Online');
    await waitState(A.page, '1002', 'Online');
    await waitState(B.page, '1001', 'Online');
    await waitState(B.page, '1002', 'Online');
  });

  test('normal call 1001 -> 1002 RINGS, is not auto-answered, and carries two-way audio (tests 13 and 20)', async () => {
    const mark = B.sip.length;
    await A.page.fill('#dial', '1002');
    await A.page.click('#dial-call');
    await waitBanner(B.page, /Incoming call/);
    await sleep(3500); // an auto-answering client would have answered by now
    assert.match(await bannerText(B.page), /Incoming call/, 'still ringing: ordinary calls require a manual answer');
    assert.equal(await B.page.locator('#answer').isVisible(), true);
    const invites = invitesIn(B, mark);
    assert.equal(invites.length >= 1, true, 'B received an INVITE');
    assert.doesNotMatch(invites[0].text, /X-Paging-Call/i, 'ordinary INVITE has no paging marker');
    assert.doesNotMatch(invites[0].text, /answer-after/i);
    assert.match(invites[0].text, /From: "?Office"? ?<sip:1001@/);

    await B.page.click('#answer');
    await waitBanner(A.page, /Connected/);
    await waitBanner(B.page, /Connected/);
    await waitState(A.page, '1001', 'In-Call');
    await waitState(A.page, '1002', 'In-Call');
    await waitState(B.page, '1001', 'In-Call');

    const [heardByA, heardByB] = await Promise.all([hear(A.page, { waitFor: 'a880' }), hear(B.page, { waitFor: 'a440' })]);
    assert.ok(heardByA.stream && heardByB.stream, 'both have a remote audio stream');
    assert.ok(heardByA.a880 > PRESENT, `A hears B's 880 Hz tone (got ${heardByA.a880.toFixed(3)})${D(heardByA, heardByB)}`);
    assert.ok(heardByA.a440 < ABSENT, `A must not hear its own tone (got ${heardByA.a440.toFixed(3)})`);
    assert.ok(heardByB.a440 > PRESENT, `B hears A's 440 Hz tone (got ${heardByB.a440.toFixed(3)})${D(heardByA, heardByB)}`);
    assert.ok(heardByB.a880 < ABSENT, `B must not hear its own tone (got ${heardByB.a880.toFixed(3)})`);

    await A.page.click('#hangup');
    await noCall(A.page);
    await noCall(B.page);
    await waitState(B.page, '1001', 'Online');
    await waitState(B.page, '1002', 'Online');
  });

  test('normal call 1002 -> 1001 rings and carries two-way audio (test 14)', async () => {
    await B.page.fill('#dial', '1001');
    await B.page.click('#dial-call');
    await waitBanner(A.page, /Incoming call/);
    await sleep(2000);
    assert.match(await bannerText(A.page), /Incoming call/, 'not auto-answered');
    await A.page.click('#answer');
    await waitBanner(A.page, /Connected/);
    await waitBanner(B.page, /Connected/);
    const [heardByA, heardByB] = await Promise.all([hear(A.page, { waitFor: 'a880' }), hear(B.page, { waitFor: 'a440' })]);
    assert.ok(heardByA.a880 > PRESENT && heardByA.a440 < ABSENT, `A hears only B (880=${heardByA.a880.toFixed(3)} 440=${heardByA.a440.toFixed(3)})${D(heardByA, heardByB)}`);
    assert.ok(heardByB.a440 > PRESENT && heardByB.a880 < ABSENT, `B hears only A (440=${heardByB.a440.toFixed(3)} 880=${heardByB.a880.toFixed(3)})${D(heardByA, heardByB)}`);
    await B.page.click('#hangup');
    await noCall(A.page);
    await noCall(B.page);
  });

  test('a rejected call is reported to the caller and nothing is connected', async () => {
    await A.page.fill('#dial', '1002');
    await A.page.click('#dial-call');
    await waitBanner(B.page, /Incoming call/);
    await B.page.click('#reject');
    await noCall(B.page);
    await noCall(A.page);
    await A.page.waitForSelector('.toast.error');
    assert.match(await A.page.locator('.toast.error').first().innerText(), /Call failed/);
  });

  test('1001 -> 600 returns the caller\'s own voice (echo test, WebRTC path)', async () => {
    await A.page.click('#echo-test');
    await waitBanner(A.page, /Connected/);
    const heard = await hear(A.page, { ms: 1500, waitFor: 'a440' });
    assert.ok(heard.a440 > PRESENT, `A hears its own 440 Hz tone echoed (got ${heard.a440.toFixed(3)})${D(heard)}`);
    assert.ok(heard.a880 < ABSENT, 'and nothing else');
    await A.page.click('#hangup');
    await noCall(A.page);
  });

  test('click-to-call (POST /api/originate) rings 1001 then connects to 1002 with audio, and /api/hangup ends it', async () => {
    const res = await api.post('/api/originate', { data: { from: '1001', to: '1002' } });
    assert.equal(res.status(), 202, await res.text());
    await waitBanner(A.page, /Incoming call/);
    await A.page.click('#answer');
    await waitBanner(B.page, /Incoming call/);
    await B.page.click('#answer');
    await waitBanner(A.page, /Connected/);
    await waitBanner(B.page, /Connected/);
    const [heardByA, heardByB] = await Promise.all([hear(A.page, { waitFor: 'a880' }), hear(B.page, { waitFor: 'a440' })]);
    assert.ok(heardByA.a880 > PRESENT && heardByB.a440 > PRESENT, `audio flows both ways on an originated call (A880=${heardByA.a880.toFixed(3)} B440=${heardByB.a440.toFixed(3)})${D(heardByA, heardByB)}`);
    const hang = await api.post('/api/hangup', { data: { extension: '1001' } });
    assert.equal(hang.status(), 200, await hang.text());
    await noCall(A.page);
    await noCall(B.page);
    const rows = await audit('call.originate');
    assert.ok(rows.some((r) => r.target === '1001->1002' && r.status === 'success' && r.username === 'admin'));
  });

  test('Page All from 1001: 1002 auto-answers with the paging headers, hears the operator, and cannot talk back (tests 16, 19, 21, 22)', async () => {
    const mark = B.sip.length;
    await A.page.locator('button[data-group="700"]').click();

    // Recipient answers by itself - nobody touched B's page.
    await waitBanner(B.page, /From Page 700.*Connected.*listen only/s, 20000);
    assert.equal(await B.page.locator('#answer').count(), 0, 'no Answer button was ever needed');

    // The INVITE B received on the wire carries every paging marker.
    const invite = invitesIn(B, mark)[0];
    assert.ok(invite, 'B received the paging INVITE');
    assert.match(invite.text, /^INVITE sip:[^ ]+;transport=WS SIP\/2\.0/, "delivered over the browser's registered WebSocket contact");
    assert.match(invite.text, /^X-Paging-Call: true$/mi, 'X-Paging-Call: true');
    assert.match(invite.text, /^Call-Info: <sip:[^>]+>;\s*answer-after=0$/mi, 'Call-Info auto-answer marker');
    assert.match(invite.text, /^P-Asserted-Identity: .*Paging System.*sip:paging@/mi, 'P-Asserted-Identity');
    assert.match(invite.text, /^From: .*<sip:700@/mi, 'presented as the paging group 700');

    // Real-time state on both dashboards
    await waitState(A.page, '1001', 'Paging');
    await waitState(A.page, '1002', 'Paging');
    await waitState(B.page, '1002', 'Paging');
    assert.match(await A.page.locator('.banner.paging').innerText(), /on air/i);

    // Audio direction: operator -> recipient yes, recipient -> operator no.
    const [heardByA, heardByB] = await Promise.all([hear(A.page, { ms: 2500 }), hear(B.page, { waitFor: 'a440', ms: 1500 })]);
    const why = JSON.stringify({ operatorA: await diagnostics(A.page), recipientB: await diagnostics(B.page) });
    assert.ok(heardByA.packets > 20, `RTP is flowing to the operator (${heardByA.packets} packets), so its silence is real, not a dead media path ${why}`);
    assert.ok(heardByB.stream && heardByB.a440 > PRESENT, `recipient hears the operator's microphone (440=${heardByB.a440.toFixed(3)}) ${why}`);
    assert.ok(heardByB.a880 < ABSENT, 'recipient does not hear itself');
    assert.ok(heardByA.a880 < ABSENT, `operator must NOT hear the recipient (880=${heardByA.a880.toFixed(3)}): paging is one-way`);
    assert.ok(heardByA.a440 < ABSENT, 'operator does not hear itself either');
    // B has no controls that transmit: listen only.
    assert.equal(await B.page.locator('#mute').count(), 0);

    // A second page while this one is live is refused.
    const second = await api.post('/api/page', { data: { group: '702' } });
    assert.equal(second.status(), 409);

    // Operator ends the page; recipient is released cleanly.
    await A.page.click('#end-page');
    await noCall(A.page);
    await noCall(B.page);
    await waitState(A.page, '1001', 'Online');
    await waitState(B.page, '1002', 'Online');
    await A.page.waitForFunction(() => !document.querySelector('.banner.paging'));

    // Audit trail: request, success (page started), end (with duration)
    await sleep(500);
    const req = (await audit('paging.request')).filter((r) => r.username === USERS.office.username && r.target === '700');
    const ok = (await audit('paging.success')).filter((r) => r.username === USERS.office.username && r.target === '700');
    const end = (await audit('paging.end')).filter((r) => r.username === USERS.office.username && r.target === '700');
    assert.ok(req.length && ok.length && end.length, 'paging.request, paging.success and paging.end were audited');
    assert.equal(typeof end[0].details.durationSeconds, 'number');
  });

  test('Page Warehouse (702) from 1001 reaches only 1002; Page Office (701) from 1002 reaches only 1001 (tests 17, 18)', async () => {
    // 702 from A: target B
    await A.page.locator('button[data-group="702"]').click();
    await waitBanner(B.page, /From Page 702.*Connected.*listen only/s, 20000);
    const heard = await hear(B.page, { waitFor: 'a440', ms: 1200 });
    assert.ok(heard.a440 > PRESENT, `B hears the 702 page${D(heard)} OPERATOR=${JSON.stringify(await diagnostics(A.page))}`);
    await A.page.click('#end-page');
    await noCall(A.page);
    await noCall(B.page);

    // 701 from B: target A (Office)
    await B.page.locator('button[data-group="701"]').click();
    await waitBanner(A.page, /From Page 701.*Connected.*listen only/s, 20000);
    const heardA = await hear(A.page, { waitFor: 'a880', ms: 1200 });
    assert.ok(heardA.a880 > PRESENT, `A hears the 701 page from B (880=${heardA.a880.toFixed(3)})${D(heardA)} OPERATOR=${JSON.stringify(await diagnostics(B.page))}`);
    const heardB = await hear(B.page, { ms: 2000 });
    assert.ok(heardB.packets > 20, 'RTP is flowing to the operator');
    assert.ok(heardB.a880 < ABSENT && heardB.a440 < ABSENT, 'the operator does not hear the recipient');
    await B.page.click('#end-page');
    await noCall(B.page);
    await noCall(A.page);

    // 701 from A would be paging yourself: refused up front (only 1001 is in that group)
    await A.page.locator('button[data-group="701"]').click();
    await A.page.waitForSelector('.toast.error');
    assert.match(await A.page.locator('.toast.error').last().innerText(), /nobody to page|only member/i);
    assert.equal(await A.page.locator('#call-banner').count(), 0, 'no call was placed');
  });

  test('SIP credentials alone cannot page: dialling 700 without backend authorisation is refused by Asterisk', async () => {
    await sleep(1500);
    const markB = B.sip.length;
    await A.page.fill('#dial', '700');
    await A.page.click('#dial-call');
    await A.page.waitForSelector('.toast.error:has-text("Call failed")', { timeout: 10000 });
    await noCall(A.page);
    await sleep(1000);
    assert.equal(invitesIn(B, markB).length, 0, 'nobody was paged');
    await waitState(B.page, '1002', 'Online');
  });

  test('the read-only user role cannot page or originate (UI hides it, backend refuses)', async () => {
    const viewer = await launchOperator({ ...USERS.viewer, tone: 440 });
    await signIn(viewer);
    await viewer.page.waitForSelector('article[data-extension="1001"]');
    // no microphone gate, no softphone, no page buttons
    assert.equal(await viewer.page.locator('button[data-group]').count(), 0);
    assert.equal(await viewer.page.locator('#dial').count(), 0);
    assert.equal(await viewer.page.locator('#chip-sip').count(), 0);
    assert.match(await viewer.page.locator('main').innerText(), /read-only/i);
    // ...but live status is visible
    assert.equal(await stateOf(viewer.page, '1001'), 'Online');
    // the backend refuses regardless of the UI
    const statuses = await viewer.page.evaluate(async () => {
      const post = (path, body) => fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
      return [await post('/page', { group: '700' }), await post('/originate', { from: '1001', to: '1002' }), await fetch('/api/users').then((r) => r.status), await fetch('/api/audit').then((r) => r.status), await fetch('/api/sip/config').then((r) => r.status)];
    });
    assert.deepEqual(statuses, [403, 403, 403, 403, 403]);
    // admin-only pages are not reachable through the UI either
    await viewer.page.goto(`${BASE}/#/users`);
    await viewer.page.waitForSelector('article[data-extension="1001"]');
    await viewer.browser.close();
  });

  test('closing a browser takes its extension Offline on the other dashboard in real time (test 23)', async () => {
    await B.page.close();
    await waitState(A.page, '1002', 'Offline', 45000);
    assert.equal(await stateOf(A.page, '1002'), 'Offline');
    assert.equal(await stateOf(A.page, '1001'), 'Online');
  });

  test('no unexpected JavaScript errors occurred in the operator pages', async () => {
    assert.deepEqual(A.problems, []);
    assert.deepEqual(B.problems, []);
  });
});
