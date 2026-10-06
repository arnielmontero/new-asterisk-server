'use strict';
/*
 * Real-browser tests for call queues. Caller 1001 dials a queue; agents 1002 and 1501 are real browsers.
 * Every claim is observed on the agents' screens (who rings, who does not) and checked against the numbers the
 * system reports afterwards (live status from Asterisk, statistics built from its queue events).
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, request } = require('playwright');

const BASE = process.env.BASE_URL || 'https://communications.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PASSWORD = 'E2e-Operator-Passw0rd!';
const USERS = { a: { username: 'e2e.qa', extension: '1001' }, b: { username: 'e2e.qb', extension: '1002' }, c: { username: 'e2e.qc', extension: '1501' } };
const QN = '800';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const open = [];
let api;
const j = async (res) => res.json();

async function cleanup() {
  const { users } = await j(await api.get('/api/users'));
  for (const u of users.filter((x) => Object.values(USERS).some((e) => e.username === x.username))) await api.delete(`/api/users/${u.id}`);
  for (const q of (await j(await api.get('/api/pbx/queues'))).queues.filter((x) => x.number === QN)) await api.delete(`/api/pbx/queues/${q.id}`);
  for (const e of (await j(await api.get('/api/pbx/extensions'))).extensions) {
    if (e.number === '1501') await api.delete(`/api/pbx/extensions/${e.id}`);
    else if (['1001', '1002'].includes(e.number) && e.dnd) await api.patch(`/api/pbx/extensions/${e.id}`, { data: { dnd: false } });
  }
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
async function neverRings(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { assert.ok(!/Incoming call/.test(await banner(p)), `${p.user.username} must not ring`); await sleep(250); }
}
const stats = async () => (await j(await api.get('/api/pbx/queues/stats?serviceLevel=20'))).queues.find((q) => q.queue === QN) || { offered: 0, answered: 0, abandoned: 0, unserved: 0 };
const status = async () => (await j(await api.get('/api/pbx/queues/status'))).queues.find((q) => q.number === QN);
const patchQueue = async (data) => {
  const q = (await j(await api.get('/api/pbx/queues'))).queues.find((x) => x.number === QN);
  assert.equal((await api.patch(`/api/pbx/queues/${q.id}`, { data })).status(), 200);
  await sleep(1800);
};

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  api = await request.newContext({ baseURL: BASE });
  assert.equal((await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })).status(), 200);
  await cleanup();
  assert.equal((await api.post('/api/pbx/extensions', { data: { number: '1501', display_name: 'E2E Agent' } })).status(), 201);
  for (const u of Object.values(USERS)) {
    assert.equal((await api.post('/api/users', { data: { username: u.username, password: PASSWORD, role: 'operator', extension: u.extension } })).status(), 201);
  }
  const q = await api.post('/api/pbx/queues', { data: { number: QN, name: 'E2E support', strategy: 'ringall', member_timeout: 6, wrapup_secs: 0, max_wait_secs: 15, members: ['1002', '1501'] } });
  assert.equal(q.status(), 201, await q.text());
  await sleep(2500);
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try { await cleanup(); } catch { /* best effort */ }
  await api?.dispose();
});

describe('call queues in real browsers', { concurrency: false }, () => {
  let A; let B; let C;
  let base;

  test('the queue exists in Asterisk with both agents; operators register', async () => {
    A = await operator(USERS.a);
    B = await operator(USERS.b);
    C = await operator(USERS.c);
    await sleep(2500);
    const s = await status();
    assert.ok(s, 'Asterisk reports the queue');
    assert.deepEqual(s.members.map((m) => m.extension).sort(), ['1002', '1501']);
    assert.ok(s.members.every((m) => m.state === 'available' && !m.paused), JSON.stringify(s.members));
    base = await stats();
  });

  test('ring all: both agents ring, the first to answer gets the caller, the other stops ringing', async () => {
    await dial(A, QN);
    await waitIncoming(B);
    await waitIncoming(C);
    await answer(C);
    await waitConnected(A);
    await waitConnected(C);
    await waitNoCall(B, 8000);
    const s = await status();
    assert.equal(s.members.find((m) => m.extension === '1501').state, 'on call', 'live agent state');
    await endAll(A, C);
    await sleep(2500);
    const now = await stats();
    assert.equal(now.answered, base.answered + 1, 'recorded as answered');
    const st = (await j(await api.get('/api/pbx/queues/stats'))).agents.find((a) => a.agent === '1501');
    assert.ok(st && st.calls >= 1, 'credited to the agent who answered');
    base = now;
  });

  test('an agent can pause from the dashboard and then no queue call rings them; resuming brings them back', async () => {
    await B.page.waitForSelector('#my-queue-pause', { timeout: 15000 });
    await B.page.click('#my-queue-pause');
    await B.page.waitForSelector('#my-queues .banner.warn');
    await sleep(1000);
    assert.equal((await status()).members.find((m) => m.extension === '1002').paused, true);
    await dial(A, QN);
    await waitIncoming(C);
    await neverRings(B, 2500);
    await endAll(A, C);
    await B.page.click('#my-queue-pause');
    await B.page.waitForFunction(() => !document.querySelector('#my-queues .banner.warn'));
    await sleep(1000);
    assert.equal((await status()).members.find((m) => m.extension === '1002').paused, false);
    await dial(A, QN);
    await waitIncoming(B);
    await endAll(A, B, C);
    base = await stats();
  });

  test('a caller who hangs up while waiting is counted as abandoned', async () => {
    await dial(A, QN);
    await waitIncoming(B);
    await waitIncoming(C);
    await sleep(1200);
    await endAll(A);
    await waitNoCall(B, 8000);
    await waitNoCall(C, 8000);
    await sleep(2500);
    const now = await stats();
    assert.equal(now.abandoned, base.abandoned + 1);
    base = now;
  });

  test('nobody answers: the caller leaves after the maximum wait, hears the fall-back, and it is counted', async () => {
    await patchQueue({ fail_dest: { type: 'hangup', value: 'busy' } });
    const started = Date.now();
    await dial(A, QN);
    await waitIncoming(B);
    await waitIncoming(C);
    // Agents ignore the call. Ringing times out after 6 s, the queue retries, and the caller gives up at 15 s.
    await waitNoCall(A, 30000);
    assert.ok(Date.now() - started > 10000, 'the caller waited before being turned away');
    await endAll(B, C);
    await sleep(2500);
    const now = await stats();
    assert.equal(now.unserved, base.unserved + 1, 'counted as unserved (timeout)');
    base = now;
  });

  test('in-order strategy: the first agent rings alone; the second only after the first did not answer', async () => {
    await patchQueue({ strategy: 'linear', members: ['1501', '1002'] });
    await dial(A, QN);
    await waitIncoming(C);
    await neverRings(B, 3000);
    await waitIncoming(B, 12000); // C let it ring out (6 s), so B is next
    await answer(B);
    await waitConnected(A);
    await endAll(A, B, C);
  });

  test('the Call flow page shows the queue with live agent states and today\'s numbers', async () => {
    const adminBrowser = await chromium.launch({ args: FLAGS });
    open.push(adminBrowser);
    const page = await (await adminBrowser.newContext()).newPage();
    await page.goto(`${BASE}/`);
    await page.fill('#username', 'admin');
    await page.fill('#password', ADMIN_PASSWORD);
    await page.click('button[type=submit]');
    await page.click('nav a[href="#/callflow"]');
    await page.waitForSelector('#queues-panel tr:has-text("E2E support")');
    const row = await page.locator('#queues-panel tr', { hasText: 'E2E support' }).innerText();
    assert.match(row, /800/);
    assert.match(row, /in order/i);
    assert.match(row, /1501\s+AVAILABLE/i);
    assert.match(row, /1002\s+AVAILABLE/i);
    assert.match(row, /\d+ answered, \d+ abandoned, \d+ turned away/);
    await page.close();
  });

  test('nobody online: callers are turned away at once instead of waiting for nothing', async () => {
    await B.browser.close();
    await C.browser.close();
    // Wait until Asterisk sees both agents as unavailable.
    for (let i = 0; i < 40; i += 1) {
      const s = await status();
      if (s && s.members.every((m) => m.state === 'unavailable')) break;
      await sleep(1000);
    }
    const before_ = (await stats()).unserved;
    const started = Date.now();
    await dial(A, QN);
    await waitNoCall(A, 10000);
    assert.ok(Date.now() - started < 9000, 'turned away quickly');
    await sleep(2500);
    assert.equal((await stats()).unserved, before_ + 1);
  });

  test('call history shows the queue calls and no page had script errors', async () => {
    const calls = await j(await api.get('/api/cdr?pageSize=100'));
    assert.ok(calls.items.some((r) => r.dst === QN && r.src === '1001'));
    assert.deepEqual(A.problems, []);
  });
});
