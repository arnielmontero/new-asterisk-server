'use strict';
/*
 * Real-browser tests for voicemail and call recording. Callers and the box owner are real browsers with a fake
 * microphone (a periodic tone). Every claim is observed on screen (the voicemail panel, the recordings page, the
 * call history) and checked against the audio itself: messages and recordings are downloaded and must contain sound.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, request } = require('playwright');

const BASE = process.env.BASE_URL || 'https://communications.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PASSWORD = 'E2e-Operator-Passw0rd!';
const USERS = { a: { username: 'e2e.va', extension: '1001' }, b: { username: 'e2e.vb', extension: '1503' } };
const BOX = '1503';
const TRUNK = 'e2e-vmloop';
const DID = '5550177';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const open = [];
let api;
let boxId;
const j = async (res) => res.json();

async function cleanup() {
  const { users } = await j(await api.get('/api/users'));
  for (const u of users.filter((x) => Object.values(USERS).some((e) => e.username === x.username))) await api.delete(`/api/users/${u.id}`);
  for (const e of (await j(await api.get('/api/pbx/extensions'))).extensions) {
    if (e.number === BOX) await api.delete(`/api/pbx/extensions/${e.id}`);
    else if (e.number === '1001' && (e.record_calls || e.voicemail_enabled || e.allow_outbound)) await api.patch(`/api/pbx/extensions/${e.id}`, { data: { record_calls: false, voicemail_enabled: false, allow_outbound: false } });
  }
  for (const m of (await j(await api.get('/api/voicemail'))).messages.filter((x) => x.extension === BOX)) await api.delete(`/api/voicemail/${m.id}`);
  for (const r of (await j(await api.get('/api/pbx/outbound-routes'))).routes.filter((x) => x.name === 'E2E VM out')) await api.delete(`/api/pbx/outbound-routes/${r.id}`);
  for (const r of (await j(await api.get('/api/pbx/inbound-routes'))).routes.filter((x) => x.name === 'E2E VM in')) await api.delete(`/api/pbx/inbound-routes/${r.id}`);
  for (const t of (await j(await api.get('/api/pbx/trunks'))).trunks.filter((x) => x.name === TRUNK)) await api.delete(`/api/pbx/trunks/${t.id}`);
  for (const r of (await j(await api.get('/api/recordings?pageSize=100'))).items) await api.delete(`/api/recordings/${r.id}`);
}

async function operator(user) {
  const browser = await chromium.launch({ args: FLAGS });
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
  return { page, user, problems, browser };
}

const banner = (p) => p.page.evaluate(() => document.querySelector('#call-banner')?.textContent || '').catch(() => '');
const waitIncoming = (p, t = 12000) => p.page.waitForFunction(() => /Incoming call/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: t });
const waitConnected = (p, t = 12000) => p.page.waitForFunction(() => /Connected/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: t });
const waitNoCall = (p, t = 15000) => p.page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout: t });
const dial = async (p, n) => { await p.page.fill('#dial', n); await p.page.click('#dial-call'); };
const answer = (p) => p.page.locator('#answer').click({ timeout: 5000 });
async function endAll(...ops) {
  for (const p of ops) for (const sel of ['#hangup', '#reject']) { const b = p.page.locator(sel); if (await b.count()) await b.first().click({ timeout: 2000 }).catch(() => {}); }
  await sleep(2000);
}
const messages = async () => (await j(await api.get(`/api/voicemail?extension=${BOX}`))).messages;
const recordings = async () => (await j(await api.get('/api/recordings?pageSize=100'))).items;
const patchBox = async (data) => { assert.equal((await api.patch(`/api/pbx/extensions/${boxId}`, { data })).status(), 200); await sleep(1800); };
const patchA = async (data) => {
  const a = (await j(await api.get('/api/pbx/extensions'))).extensions.find((e) => e.number === '1001');
  assert.equal((await api.patch(`/api/pbx/extensions/${a.id}`, { data })).status(), 200);
  await sleep(1800);
};

/** Root-mean-square level of a 16-bit WAV (0 = silence, a speech/tone level is in the thousands). */
async function loudness(url) {
  const res = await api.get(url);
  assert.equal(res.status(), 200);
  const buf = await res.body();
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  let sum = 0; let n = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; n += 1; }
  return { rms: Math.sqrt(sum / Math.max(1, n)), samples: n };
}

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  api = await request.newContext({ baseURL: BASE });
  assert.equal((await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })).status(), 200);
  await cleanup();
  const made = await api.post('/api/pbx/extensions', { data: { number: BOX, display_name: 'E2E Box', voicemail_enabled: true, voicemail_max_secs: 60, record_calls: true, } });
  assert.equal(made.status(), 201, await made.text());
  boxId = (await made.json()).extension.id;
  for (const u of Object.values(USERS)) {
    assert.equal((await api.post('/api/users', { data: { username: u.username, password: PASSWORD, role: 'operator', extension: u.extension } })).status(), 201);
  }
  await patchBox({ noanswer_secs: 5 });
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try { await cleanup(); } catch { /* best effort */ }
  await api?.dispose();
});

describe('voicemail and call recording in real browsers', { concurrency: false }, () => {
  let A; let B;

  test('a caller who reaches a box nobody is logged in to leaves a message that arrives live and contains sound', async () => {
    A = await operator(USERS.a);
    await dial(A, BOX);
    await waitConnected(A, 15000); // the box answers
    await sleep(5000); // speak (the fake microphone sends a tone)
    await endAll(A);
    await waitNoCall(A, 8000);
    await sleep(1500);
    const list = await messages();
    assert.equal(list.length, 1, 'one message');
    assert.equal(list[0].caller, '1001');
    assert.ok(list[0].duration_secs >= 3, `message length ${list[0].duration_secs}`);
    assert.equal(list[0].heard, false);
    const level = await loudness(`/api/voicemail/${list[0].id}/audio`);
    assert.ok(level.rms > 300, `the message must contain the caller's sound (level ${level.rms})`);
    assert.equal((await recordings()).length, 0, 'a voicemail is not a bridged conversation: nothing is recorded');
  });

  test('the owner signs in, sees the message marked new, plays it and it becomes heard', async () => {
    B = await operator(USERS.b);
    await B.page.waitForSelector('#my-voicemail .vm-row.unread', { timeout: 8000 });
    assert.match(await B.page.textContent('#vm-unread'), /1 new/);
    assert.match(await B.page.textContent('#my-voicemail .vm-row'), /1001/);
    // Listening marks it heard.
    await B.page.evaluate(() => { const a = document.querySelector('#my-voicemail audio'); a.muted = true; return a.play(); });
    await B.page.waitForFunction(() => !document.querySelector('#my-voicemail .vm-row.unread'), null, { timeout: 8000 });
    assert.equal((await messages())[0].heard, true);
  });

  test('do not disturb sends the caller to voicemail and the new message appears on the open dashboard without a reload', async () => {
    await patchBox({ dnd: true });
    const before = (await messages()).length;
    await dial(A, BOX);
    await waitConnected(A, 15000);
    await sleep(4500);
    await endAll(A);
    await B.page.waitForSelector('#my-voicemail .vm-row.unread', { timeout: 10000 });
    assert.equal((await messages()).length, before + 1);
    assert.equal(await B.page.locator('#my-voicemail .vm-row').count(), before + 1);
    assert.ok(!/Incoming call/.test(await banner(B)), 'the box owner was not rung');
    await patchBox({ dnd: false });
  });

  test('no answer: the phone rings for the set time, then the caller gets the voicemail', async () => {
    const before = (await messages()).length;
    const t0 = Date.now();
    await dial(A, BOX);
    await waitIncoming(B);
    await waitConnected(A, 15000); // the voicemail answers once ringing stops
    const waited = (Date.now() - t0) / 1000;
    assert.ok(waited >= 4.5 && waited < 12, `rang for ${waited}s (set to 5)`);
    await sleep(4500);
    await endAll(A);
    await waitNoCall(B, 8000);
    await sleep(1500);
    assert.equal((await messages()).length, before + 1);
  });

  test('a message can be marked new again and deleted from the dashboard; its file is gone', async () => {
    const [newest] = await messages();
    await B.page.waitForSelector(`#my-voicemail [data-message="${newest.id}"]`);
    const row = B.page.locator(`#my-voicemail [data-message="${newest.id}"]`);
    if (newest.heard) await row.getByRole('button', { name: 'Mark as new' }).click();
    else await row.getByRole('button', { name: 'Mark as heard' }).click();
    await sleep(800);
    assert.notEqual((await messages()).find((m) => m.id === newest.id).heard, newest.heard);
    B.page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'Delete' }).click();
    await B.page.waitForFunction((id) => !document.querySelector(`#my-voicemail [data-message="${id}"]`), newest.id, { timeout: 8000 });
    assert.ok(!(await messages()).some((m) => m.id === newest.id));
    assert.equal((await api.get(`/api/voicemail/${newest.id}/audio`)).status(), 404);
  });

  test('a conversation with a recorded extension is recorded once, with sound, and shows in the recordings page and call history', async () => {
    await patchA({ record_calls: true }); // both ends are now recorded: still one recording
    const before = (await recordings()).length;
    await dial(A, BOX);
    await waitIncoming(B);
    await answer(B);
    await waitConnected(A);
    await waitConnected(B);
    await sleep(6000);
    await endAll(A, B);
    await sleep(3000);
    const now = await recordings();
    assert.equal(now.length, before + 1, 'exactly one recording although both extensions record');
    const rec = now[0];
    assert.equal(rec.src, '1001');
    assert.equal(rec.dst, BOX);
    assert.ok(rec.duration_secs >= 4, `recorded ${rec.duration_secs}s`);
    const level = await loudness(`/api/recordings/${rec.id}/audio`);
    assert.ok(level.rms > 300, `the recording must contain the conversation (level ${level.rms})`);

    // As an administrator in a browser: the recordings page and the call history both offer it.
    const admin = await (await (await chromium.launch({ args: FLAGS })).newContext()).newPage();
    open.push(admin.context().browser());
    await admin.goto(`${BASE}/`);
    await admin.fill('#username', 'admin');
    await admin.fill('#password', ADMIN_PASSWORD);
    await admin.click('button[type=submit]');
    await admin.waitForSelector('.topbar');
    await admin.goto(`${BASE}/#/recordings`);
    await admin.waitForSelector('audio[src^="/api/recordings/"]', { timeout: 8000 });
    assert.match(await admin.textContent('main'), /1001/);
    await admin.goto(`${BASE}/#/calls`);
    await admin.waitForSelector(`button[data-recording="${rec.id}"]`, { timeout: 8000 });
    await admin.locator(`button[data-recording="${rec.id}"]`).click();
    await admin.waitForSelector('.dialog audio', { timeout: 5000 });
    await admin.context().browser().close();
    await patchA({ record_calls: false });
  });

  test('a call to a recorded extension from an unrecorded one is recorded, and recording can be deleted by the administrator', async () => {
    const before = await recordings();
    await dial(A, BOX);
    await waitIncoming(B);
    await answer(B);
    await waitConnected(A);
    await sleep(4500);
    await endAll(A, B);
    await sleep(3000);
    const now = await recordings();
    assert.equal(now.length, before.length + 1, 'the callee side alone is enough');
    for (const r of now) assert.equal((await api.delete(`/api/recordings/${r.id}`)).status(), 200);
    assert.equal((await recordings()).length, 0);
  });

  test('a trunk with recording on records the calls through it, in both directions', async () => {
    // A loopback trunk (the PBX calls itself): a call leaves through the outbound route and comes back in through the trunk.
    const t = await api.post('/api/pbx/trunks', { data: { name: TRUNK, display_name: 'E2E VM loop', auth_mode: 'ip', host: '127.0.0.1', record_calls: true } });
    assert.equal(t.status(), 201, await t.text());
    const trunkId = (await t.json()).trunk.id;
    assert.equal((await api.post('/api/pbx/inbound-routes', { data: { name: 'E2E VM in', did: DID, trunk_id: trunkId, destination: { type: 'echo', value: '' } } })).status(), 201);
    assert.equal((await api.post('/api/pbx/outbound-routes', { data: { name: 'E2E VM out', patterns: ['_8X.'], strip: 1, prepend: '', cid_num: null, emergency: false, trunks: [trunkId], position: 0, enabled: true } })).status(), 201);
    await patchA({ allow_outbound: true });
    for (let i = 0; i < 90; i += 1) {
      const st = (await j(await api.get('/api/pbx/trunks/status'))).trunks.find((x) => x.name === TRUNK);
      if (st && st.state === 'online') break;
      await sleep(1000);
    }
    await dial(A, `8${DID}`);
    await waitConnected(A, 20000);
    await sleep(6000);
    await endAll(A);
    await sleep(3500);
    const made = await recordings();
    assert.ok(made.length >= 1 && made.length <= 2, `recorded ${made.length} time(s)`);
    for (const r of made) {
      assert.ok(r.duration_secs >= 3, `recorded ${r.duration_secs}s`);
      assert.ok((await loudness(`/api/recordings/${r.id}/audio`)).rms > 300, 'the recording contains the call');
    }
    assert.ok(made.some((r) => r.direction === 'outbound' || r.direction === 'inbound'), 'the call history knows these as trunk calls');
    for (const r of made) await api.delete(`/api/recordings/${r.id}`);
    // Recording switched off on the trunk: nothing more is recorded.
    assert.equal((await api.patch(`/api/pbx/trunks/${trunkId}`, { data: { record_calls: false } })).status(), 200);
    await sleep(1800);
    await dial(A, `8${DID}`);
    await waitConnected(A, 20000);
    await sleep(4000);
    await endAll(A);
    await sleep(3000);
    assert.equal((await recordings()).length, 0);
  });

  test('with recording off, nothing is recorded', async () => {
    await patchBox({ record_calls: false });
    await dial(A, BOX);
    await waitIncoming(B);
    await answer(B);
    await waitConnected(A);
    await sleep(3500);
    await endAll(A, B);
    await sleep(2500);
    assert.equal((await recordings()).length, 0);
    for (const p of [A, B]) assert.deepEqual(p.problems, [], `${p.user.username} page errors`);
  });
});
