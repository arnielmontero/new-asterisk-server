'use strict';
/*
 * Real-browser tests for hold, blind and attended transfer, call parking and call pickup. Three browsers each send their own
 * pure tone (440, 880, 1320 Hz), so what each one hears shows exactly who is connected to whom after every step.
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
  a: { username: 'e2e.tra', extension: '1001', tone: 440 },
  b: { username: 'e2e.trb', extension: '1002', tone: 880 },
  c: { username: 'e2e.trc', extension: '1505', tone: 1320 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-xfer-'));
const open = [];
let api;
const j = async (res) => res.json();
const LOUD = 0.05;

function writeTone(file, freq, seconds = 1, rate = 48000, amplitude = 0.5) {
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

async function cleanup() {
  const { users } = await j(await api.get('/api/users'));
  for (const u of users.filter((x) => Object.values(USERS).some((e) => e.username === x.username))) await api.delete(`/api/users/${u.id}`);
  for (const e of (await j(await api.get('/api/pbx/extensions'))).extensions.filter((x) => x.number === USERS.c.extension)) await api.delete(`/api/pbx/extensions/${e.id}`);
}

async function operator(user) {
  const tone = path.join(tmp, `tone-${user.tone}.wav`);
  writeTone(tone, user.tone);
  const browser = await chromium.launch({ args: [...FLAGS, `--use-file-for-fake-audio-capture=${tone}`] });
  open.push(browser);
  const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${BASE}/`);
  await page.fill('#username', user.username);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.getByRole('button', { name: 'Enable microphone and audio' }).click();
  await page.waitForFunction(() => /registered \(\d+\)/.test(document.querySelector('#chip-sip')?.textContent || ''), null, { timeout: 25000 });
  return { page, user, problems };
}

const waitIncoming = (p, t = 12000) => p.page.waitForFunction(() => /Incoming call/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: t });
const waitConnected = (p, t = 12000) => p.page.waitForFunction(() => /Connected/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: t });
const waitNoCall = (p, t = 15000) => p.page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout: t });
const dial = async (p, n) => { await p.page.fill('#dial', n); await p.page.click('#dial-call'); };
const answer = (p) => p.page.locator('#answer').click({ timeout: 5000 });
const click = (p, sel) => p.page.locator(sel).click({ timeout: 5000 });
async function endAll(...ops) {
  for (const p of ops) for (const sel of ['#hangup', '#reject', '#xfer-cancel']) { const b = p.page.locator(sel); if (await b.count()) await b.first().click({ timeout: 2000 }).catch(() => {}); }
  await sleep(1500);
}
async function connect(from, to) {
  await dial(from, to.user.extension);
  await waitIncoming(to);
  await answer(to);
  await waitConnected(from);
  await waitConnected(to);
  await sleep(1500);
}

/** Strongest level of each frequency in the call audio this browser receives over `ms`. */
async function hear(p, freqs, ms = 3000) {
  return p.page.evaluate(async ({ freqs: fs_, ms: dur }) => {
    const el = document.getElementById('remote-audio');
    const stream = el && el.srcObject;
    if (!stream) return Object.fromEntries(fs_.map((f) => [f, 0]));
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
    const best = Object.fromEntries(fs_.map((f) => [f, 0]));
    const end = performance.now() + dur;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 150));
      an.getFloatTimeDomainData(buf);
      for (const f of fs_) best[f] = Math.max(best[f], amp(f));
    }
    await ctx.close();
    return best;
  }, { freqs, ms });
}
const ALL = [440, 880, 1320];

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  api = await request.newContext({ baseURL: BASE });
  assert.equal((await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })).status(), 200);
  await cleanup();
  assert.equal((await api.post('/api/pbx/extensions', { data: { number: USERS.c.extension, display_name: 'E2E Third' } })).status(), 201);
  for (const u of Object.values(USERS)) {
    assert.equal((await api.post('/api/users', { data: { username: u.username, password: PASSWORD, role: 'operator', extension: u.extension } })).status(), 201);
  }
  await sleep(2000);
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try { await cleanup(); } catch { /* best effort */ }
  await api?.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hold, transfer, parking and pickup in real browsers', { concurrency: false }, () => {
  let A; let B; let C;

  test('three operators register; the extension list shows every lamp', async () => {
    A = await operator(USERS.a);
    B = await operator(USERS.b);
    C = await operator(USERS.c);
    await sleep(1500);
    await A.page.waitForSelector('[data-extension="1505"] .badge.online', { timeout: 8000 });
  });

  test('hold: the other person hears nothing until the call is resumed', async () => {
    await connect(A, B);
    assert.ok((await hear(A, [880]))[880] > LOUD, 'A hears B before the hold');
    await click(B, '#hold');
    await B.page.waitForFunction(() => /on hold/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: 5000 });
    await sleep(1500);
    assert.ok((await hear(A, [880], 2500))[880] < LOUD, 'A hears nothing from B while held');
    await click(B, '#hold');
    await sleep(1500);
    assert.ok((await hear(A, [880], 2500))[880] > LOUD, 'A hears B again');
    await endAll(A, B);
  });

  test('blind transfer: B passes A to C and leaves; A and C hear each other, B is gone', async () => {
    await connect(A, B);
    await B.page.fill('#xfer-target', USERS.c.extension);
    await click(B, '#xfer-blind');
    await waitIncoming(C);
    await answer(C);
    await waitConnected(C);
    await waitNoCall(B, 10000);
    await sleep(2000);
    const [a, c] = await Promise.all([hear(A, ALL), hear(C, ALL)]);
    assert.ok(a[1320] > LOUD && a[880] < LOUD, `A now hears C, not B ${JSON.stringify(a)}`);
    assert.ok(c[440] > LOUD && c[880] < LOUD, `C hears A, not B ${JSON.stringify(c)}`);
    await endAll(A, C);
  });

  test('a transfer to a number that does not exist leaves the call as it was', async () => {
    await connect(A, B);
    await B.page.fill('#xfer-target', '4999');
    await click(B, '#xfer-blind');
    await B.page.waitForSelector('.toast', { timeout: 10000 }).catch(() => {});
    await sleep(4000);
    assert.ok((await hear(A, [880]))[880] > LOUD, 'A is still talking to B');
    assert.ok((await hear(B, [440]))[440] > LOUD, 'and B to A');
    await endAll(A, B);
  });

  test('attended transfer: B puts A on hold, talks to C, then completes; A and C are connected', async () => {
    await connect(A, B);
    await B.page.fill('#xfer-target', USERS.c.extension);
    await click(B, '#xfer-consult');
    await waitIncoming(C);
    await answer(C);
    await B.page.waitForFunction(() => /connected/.test(document.querySelector('#consult-banner')?.textContent || ''), null, { timeout: 10000 });
    await sleep(1500);
    const [b, a] = await Promise.all([hear(B, ALL), hear(A, ALL, 2500)]);
    assert.ok(b[1320] > LOUD, `B hears C ${JSON.stringify(b)}`);
    assert.ok(a[880] < LOUD && a[1320] < LOUD, `A, on hold, hears neither ${JSON.stringify(a)}`);
    await click(B, '#xfer-complete');
    await waitNoCall(B, 10000);
    await sleep(2500);
    const [a2, c2] = await Promise.all([hear(A, ALL), hear(C, ALL)]);
    assert.ok(a2[1320] > LOUD && a2[880] < LOUD, `A hears C ${JSON.stringify(a2)}`);
    assert.ok(c2[440] > LOUD && c2[880] < LOUD, `C hears A ${JSON.stringify(c2)}`);
    await endAll(A, C);
  });

  test('cancelling a consultation, or a consultation that is declined, goes back to the caller', async () => {
    await connect(A, B);
    await B.page.fill('#xfer-target', USERS.c.extension);
    await click(B, '#xfer-consult');
    await waitIncoming(C);
    await answer(C);
    await B.page.waitForFunction(() => /connected/.test(document.querySelector('#consult-banner')?.textContent || ''), null, { timeout: 10000 });
    await click(B, '#xfer-cancel');
    await waitNoCall(C, 8000);
    await B.page.waitForFunction(() => !document.querySelector('#consult-banner') && /Connected/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: 8000 });
    await sleep(2000);
    assert.ok((await hear(A, [880]))[880] > LOUD && (await hear(B, [440]))[440] > LOUD, 'A and B talk again after the cancel');

    await B.page.fill('#xfer-target', USERS.c.extension);
    await click(B, '#xfer-consult');
    await waitIncoming(C);
    await click(C, '#reject');
    await B.page.waitForFunction(() => !document.querySelector('#consult-banner'), null, { timeout: 10000 });
    await sleep(2000);
    assert.ok((await hear(A, [880]))[880] > LOUD, 'declined: B is back with A');
    await endAll(A, B);
  });

  test('park: B parks A; the slot shows on every dashboard; C picks the call up and talks to A; the slot empties', async () => {
    await connect(A, B);
    await click(B, '#park');
    await waitNoCall(B, 10000);
    await C.page.waitForSelector('#parked-calls [data-slot="751"]', { timeout: 10000 });
    assert.match(await C.page.textContent('#parked-calls'), /parked by 1002/);
    assert.match(await C.page.textContent('#parked-calls'), /1001/);
    assert.equal((await j(await api.get('/api/parking'))).parked.length, 1);
    await click(C, '#parked-calls [data-pickup-slot="751"]');
    await waitConnected(C, 15000);
    await sleep(2000);
    const [a, c] = await Promise.all([hear(A, ALL), hear(C, ALL)]);
    assert.ok(a[1320] > LOUD, `A hears C ${JSON.stringify(a)}`);
    assert.ok(c[440] > LOUD, `C hears A ${JSON.stringify(c)}`);
    await C.page.waitForFunction(() => document.querySelector('#parked-calls')?.hidden, null, { timeout: 8000 });
    assert.equal((await j(await api.get('/api/parking'))).parked.length, 0);
    await endAll(A, C);
  });

  test('pickup: a ringing extension shows a flashing lamp and anyone can answer its call', async () => {
    await dial(A, USERS.b.extension); // rings B; B does not answer
    await waitIncoming(B);
    await C.page.waitForSelector('[data-extension="1002"] .badge.ringing', { timeout: 8000 });
    await click(C, '[data-pickup="1002"]');
    await waitConnected(C, 12000);
    await waitConnected(A, 12000);
    await waitNoCall(B, 8000);
    await sleep(2000);
    const [a, c] = await Promise.all([hear(A, ALL), hear(C, ALL)]);
    assert.ok(a[1320] > LOUD && a[880] < LOUD, `A is talking to C ${JSON.stringify(a)}`);
    assert.ok(c[440] > LOUD, `C hears A ${JSON.stringify(c)}`);
    await endAll(A, C);
    // Nothing ringing: the pick-up code does nothing and the call ends.
    await dial(C, '*81002');
    await waitNoCall(C, 10000);
    for (const p of [A, B, C]) assert.deepEqual(p.problems, [], `${p.user.username} page errors`);
  });
});
