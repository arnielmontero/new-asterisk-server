'use strict';
/*
 * Real-browser tests for conference rooms. Three people join a room with PINs; each browser's microphone sends its own
 * pure tone (440, 880 and 1320 Hz), so what each one hears is measured: who can be heard by whom shows exactly who is in the
 * mix, who is muted and who has been removed.
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
const ROOM = '905';
const PIN = '4321';
const ADMIN_PIN = '9876';
const USERS = {
  a: { username: 'e2e.cfa', extension: '1001', tone: 440 },
  b: { username: 'e2e.cfb', extension: '1002', tone: 880 },
  c: { username: 'e2e.cfc', extension: '1504', tone: 1320 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-conf-'));
const open = [];
let api;
const j = async (res) => res.json();

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
  for (const c of (await j(await api.get('/api/pbx/conferences'))).conferences.filter((x) => x.number === ROOM)) await api.delete(`/api/pbx/conferences/${c.id}`);
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

const callText = (p) => p.page.evaluate(() => document.querySelector('#call-banner')?.textContent || '').catch(() => '');
const waitConnected = (p, t = 12000) => p.page.waitForFunction(() => /Connected/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: t });
const waitNoCall = (p, t = 15000) => p.page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout: t });
const dial = async (p, n) => { await p.page.fill('#dial', n); await p.page.click('#dial-call'); };
const key = (p, k) => p.page.locator(`#keypad [data-key="${k}"]`).click();
async function keys(p, text) { for (const k of text) { await key(p, k); await sleep(250); } }
const hangup = async (p) => { const b = p.page.locator('#hangup'); if (await b.count()) await b.first().click({ timeout: 2000 }).catch(() => {}); await sleep(1000); };

/** Strongest level of each frequency in the call audio this browser receives over `ms`. */
async function hear(p, freqs, ms = 3500) {
  return p.page.evaluate(async ({ freqs: fs_, ms: dur }) => {
    const el = document.getElementById('remote-audio');
    const stream = el && el.srcObject;
    if (!stream) return null;
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

const status = async () => (await j(await api.get('/api/pbx/conferences/status'))).rooms.find((r) => r.number === ROOM);
const members = async () => ((await status())?.participants || []).map((p) => p.extension).sort();
const room = async () => (await j(await api.get('/api/pbx/conferences'))).conferences.find((c) => c.number === ROOM);
const LOUD = 0.05;

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

describe('conference rooms in real browsers', { concurrency: false }, () => {
  let admin; let A; let B; let C;

  test('an administrator creates a room with PINs in the browser; it appears on the operators\' dashboards', async () => {
    const browser = await chromium.launch({ args: FLAGS });
    open.push(browser);
    admin = await (await browser.newContext()).newPage();
    await admin.goto(`${BASE}/`);
    await admin.fill('#username', 'admin');
    await admin.fill('#password', ADMIN_PASSWORD);
    await admin.click('button[type=submit]');
    await admin.waitForSelector('.topbar');
    await admin.goto(`${BASE}/#/conferences`);
    await admin.click('#add-conference');
    await admin.getByPlaceholder('e.g. 900').fill(ROOM);
    await admin.getByPlaceholder('e.g. Team meeting').fill('E2E room');
    await admin.getByPlaceholder('none: anyone can join').fill(PIN);
    await admin.getByPlaceholder('none', { exact: true }).fill(ADMIN_PIN);
    await admin.getByRole('button', { name: 'Save' }).click();
    await admin.waitForSelector('#conferences-panel td:has-text("E2E room")');
    assert.match(await admin.textContent('#conferences-panel'), /PIN, administrator PIN/);
    await sleep(2500); // applied to Asterisk in the background

    A = await operator(USERS.a);
    B = await operator(USERS.b);
    C = await operator(USERS.c);
    await A.page.waitForSelector(`#conference-rooms [data-room="${ROOM}"]`, { timeout: 8000 });
    assert.match(await A.page.textContent('#conference-rooms'), /E2E room.*0 in the room.*\(PIN\)/);
  });

  test('a wrong PIN is refused three times and the call ends; the right PIN joins', async () => {
    await A.page.click(`#conference-rooms [data-room="${ROOM}"] button`);
    await waitConnected(A);
    await sleep(1200);
    for (let i = 0; i < 3; i += 1) {
      await keys(A, '0000#');
      await sleep(2800); // the refusal tone, then the next try
    }
    await waitNoCall(A, 10000);
    assert.deepEqual(await members(), []);

    await dial(A, ROOM);
    await waitConnected(A);
    await sleep(1200);
    await keys(A, `${PIN}#`);
    await sleep(1500);
    assert.deepEqual(await members(), ['1001']);
    const me = (await status()).participants[0];
    assert.equal(me.admin, false, 'the room PIN is not the administrator PIN');
  });

  test('three people hear each other; the admin page shows who is in the room', async () => {
    await dial(B, ROOM);
    await waitConnected(B);
    await sleep(1200);
    await keys(B, `${PIN}#`);
    await dial(C, ROOM);
    await waitConnected(C);
    await sleep(1200);
    await keys(C, `${PIN}#`);
    await sleep(2000);
    assert.deepEqual(await members(), ['1001', '1002', '1504']);
    const [a, b, c] = await Promise.all([hear(A, [440, 880, 1320]), hear(B, [440, 880, 1320]), hear(C, [440, 880, 1320])]);
    assert.ok(a[880] > LOUD && a[1320] > LOUD, `A hears B and C ${JSON.stringify(a)}`);
    assert.ok(b[440] > LOUD && b[1320] > LOUD, `B hears A and C ${JSON.stringify(b)}`);
    assert.ok(c[440] > LOUD && c[880] > LOUD, `C hears A and B ${JSON.stringify(c)}`);
    assert.ok(a[440] < LOUD, `nobody hears themselves ${JSON.stringify(a)}`);

    await admin.waitForSelector(`[data-room="${ROOM}"] [data-channel]`, { timeout: 8000 });
    assert.equal(await admin.locator(`[data-room="${ROOM}"] [data-channel]`).count(), 3);
  });

  test('muting someone in the admin page silences them for the others, and unmuting brings them back', async () => {
    const row = admin.locator('[data-channel]', { hasText: '1002' });
    await row.getByRole('button', { name: 'Mute' }).click();
    await admin.waitForSelector('[data-channel]:has-text("1002"):has-text("muted")', { timeout: 8000 });
    await sleep(1200);
    const [a, c] = await Promise.all([hear(A, [880, 1320], 2500), hear(C, [440, 880], 2500)]);
    assert.ok(a[880] < LOUD, `A no longer hears B ${JSON.stringify(a)}`);
    assert.ok(a[1320] > LOUD, 'A still hears C');
    assert.ok(c[880] < LOUD && c[440] > LOUD, `C no longer hears B but hears A ${JSON.stringify(c)}`);
    await admin.locator('[data-channel]', { hasText: '1002' }).getByRole('button', { name: 'Unmute' }).click();
    await admin.waitForFunction(() => ![...document.querySelectorAll('[data-channel]')].some((r) => /1002/.test(r.textContent) && /muted/.test(r.textContent)), null, { timeout: 8000 });
    await sleep(1200);
    assert.ok((await hear(A, [880], 2500))[880] > LOUD, 'B is back');
  });

  test('removing someone ends their call; locking keeps newcomers out', async () => {
    await admin.locator('[data-channel]', { hasText: '1504' }).getByRole('button', { name: 'Remove' }).click();
    await waitNoCall(C, 8000);
    assert.deepEqual(await members(), ['1001', '1002']);

    await admin.locator('#conferences-panel').getByRole('button', { name: 'Lock' }).click();
    await admin.waitForSelector('#conferences-panel :text("LOCKED")', { timeout: 8000 });
    await dial(C, ROOM);
    await waitConnected(C);
    await sleep(1200);
    await keys(C, `${PIN}#`);
    await sleep(2500);
    assert.deepEqual(await members(), ['1001', '1002'], 'a locked room admits nobody');
    await hangup(C);
    await admin.locator('#conferences-panel').getByRole('button', { name: 'Unlock' }).click();
    await admin.waitForFunction(() => !document.querySelector('#conferences-panel')?.textContent.includes('LOCKED'), null, { timeout: 8000 });
  });

  test('the administrator PIN gives phone-keypad control: key 3 removes the person who joined last', async () => {
    await hangup(A); // A leaves and returns as the room administrator
    await dial(A, ROOM);
    await waitConnected(A);
    await sleep(1200);
    await keys(A, `${ADMIN_PIN}#`);
    await sleep(1500);
    const me = (await status()).participants.find((p) => p.extension === '1001');
    assert.equal(me.admin, true);
    await dial(C, ROOM);
    await waitConnected(C);
    await sleep(1200);
    await keys(C, `${PIN}#`);
    await sleep(1500);
    assert.deepEqual(await members(), ['1001', '1002', '1504']);
    await key(A, '3'); // admin_kick_last
    await waitNoCall(C, 8000);
    assert.deepEqual(await members(), ['1001', '1002']);
  });

  test('the member limit and mute-on-entry are applied', async () => {
    const r = await room();
    assert.equal((await api.patch(`/api/pbx/conferences/${r.id}`, { data: { max_members: 2, mute_on_join: true, pin: null, admin_pin: null } })).status(), 200);
    await sleep(2500);
    await hangup(A);
    await hangup(B);
    await sleep(1000);
    await dial(A, ROOM);
    await waitConnected(A);
    await sleep(2500);
    const first = (await status()).participants[0];
    assert.equal(first.muted, true, 'muted on entry');
    await dial(B, ROOM);
    await waitConnected(B);
    await sleep(2500);
    assert.deepEqual(await members(), ['1001', '1002']);
    await dial(C, ROOM);
    await waitConnected(C, 15000).catch(() => {});
    await sleep(3000);
    assert.deepEqual(await members(), ['1001', '1002'], 'the third person does not get in');
    for (const p of [A, B, C]) await hangup(p);
    await sleep(1500);
    assert.equal(await status(), undefined, 'an empty room disappears from Asterisk');
    for (const p of [A, B, C]) assert.deepEqual(p.problems, [], `${p.user.username} page errors`);
  });
});
