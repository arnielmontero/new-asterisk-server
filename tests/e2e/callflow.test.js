'use strict';
/*
 * Real-browser tests for call handling: do not disturb, forwarding, ring groups and time conditions.
 *
 * Three Chromium instances play operators of extensions 1001 (caller), 1002 and 1501. Every claim is
 * observed on the receiving browsers: who actually gets an incoming call, and who does not.
 * Time conditions are reached the way real callers reach them: an outside number arrives on a trunk
 * (a loopback trunk to the PBX itself) and an inbound route points at the schedule.
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
  a: { username: 'e2e.cfa', extension: '1001' },
  b: { username: 'e2e.cfb', extension: '1002' },
  c: { username: 'e2e.cfc', extension: '1501' },
};
const DID = '5559000';
const T0 = Date.now();
const log = (m) => console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const open = [];
let api;
const j = async (res) => res.json();

const NAMES = { rg: ['E2E ring all', 'E2E sequential'], tc: 'E2E hours' };

async function cleanup() {
  const { users } = await j(await api.get('/api/users'));
  for (const u of users.filter((x) => Object.values(USERS).some((e) => e.username === x.username))) await api.delete(`/api/users/${u.id}`);
  for (const r of (await j(await api.get('/api/pbx/inbound-routes'))).routes.filter((x) => x.name.startsWith('E2E'))) await api.delete(`/api/pbx/inbound-routes/${r.id}`);
  for (const r of (await j(await api.get('/api/pbx/outbound-routes'))).routes.filter((x) => x.name.startsWith('E2E'))) await api.delete(`/api/pbx/outbound-routes/${r.id}`);
  for (const t of (await j(await api.get('/api/pbx/time-conditions'))).conditions.filter((x) => x.name === NAMES.tc)) await api.delete(`/api/pbx/time-conditions/${t.id}`);
  for (const g of (await j(await api.get('/api/pbx/ring-groups'))).groups.filter((x) => ['800', '801'].includes(x.number))) await api.delete(`/api/pbx/ring-groups/${g.id}`);
  for (const t of (await j(await api.get('/api/pbx/trunks'))).trunks.filter((x) => x.name === 'e2e-cf')) await api.delete(`/api/pbx/trunks/${t.id}`);
  const exts = (await j(await api.get('/api/pbx/extensions'))).extensions;
  for (const n of ['1001', '1002']) {
    const e = exts.find((x) => x.number === n);
    if (e) await api.patch(`/api/pbx/extensions/${e.id}`, { data: { dnd: false, fwd_all: null, fwd_busy: null, fwd_noanswer: null, noanswer_secs: 25, allow_outbound: false } });
  }
  for (const e of exts.filter((x) => x.number === '1501')) await api.delete(`/api/pbx/extensions/${e.id}`);
}

const ext = async (n) => (await j(await api.get('/api/pbx/extensions'))).extensions.find((e) => e.number === n);
const patchExt = async (n, data) => assert.equal((await api.patch(`/api/pbx/extensions/${(await ext(n)).id}`, { data })).status(), 200);
const settle = () => sleep(1500); // the (debounced) apply reloads the dialplan

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
  // Record every change of the call banner, to explain a failure.
  await page.evaluate(() => {
    window.__trace = [];
    let last = '';
    new MutationObserver(() => {
      const t = document.querySelector('#call-banner')?.textContent || '(none)';
      if (t !== last) { last = t; window.__trace.push(Math.round(performance.now() / 100) / 10 + 's ' + t); }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return { page, user, problems };
}
const trace = (p) => p.page.evaluate(() => window.__trace).catch(() => []);

const banner = (p) => p.page.evaluate(() => document.querySelector('#call-banner')?.textContent || '').catch(() => '');
const waitIncoming = (p, timeout = 12000) => (log(p.user.username + ' waits for ringing'), p.page.waitForFunction(() => /Incoming call/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout }));
const waitNoCall = (p, timeout = 12000) => p.page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout });
const waitConnected = (p, timeout = 12000) => p.page.waitForFunction(() => /Connected/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout });
const dial = async (p, number) => { log(p.user.username + ' dials ' + number); await p.page.fill('#dial', number); await p.page.click('#dial-call'); };
const hangup = async (p) => { await p.page.click('#hangup').catch(() => {}); await waitNoCall(p).catch(() => {}); };
/** Assert that nothing rings on `p` for `ms`. */
async function neverRings(p, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert.ok(!/Incoming call/.test(await banner(p)), `${p.user.username} must not ring`);
    await sleep(250);
  }
}
async function endAll(...ops) {
  for (const p of ops) {
    for (const sel of ['#hangup', '#reject']) {
      const b = p.page.locator(sel);
      if (await b.count()) await b.first().click({ timeout: 2000 }).catch(() => {});
    }
  }
  await sleep(1500);
}
/** Click Answer; on failure report what the page really shows. */
async function answer(p) {
  try {
    await p.page.locator('#answer').click({ timeout: 5000 });
  } catch (err) {
    const state = await p.page.evaluate(() => ({ banners: document.querySelectorAll('#call-banner').length, answer: document.querySelectorAll('#answer').length, body: document.body.innerText.slice(0, 900), html: (document.querySelector('#call-banner')?.parentElement?.outerHTML || '').slice(0, 600) })).catch(() => '(no page)');
    throw new Error(p.user.username + ' has no Answer button. Softphone panel says: ' + JSON.stringify(state) + ' trace: ' + JSON.stringify(await trace(p)));
  }
}

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  api = await request.newContext({ baseURL: BASE });
  assert.equal((await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })).status(), 200);
  await cleanup();
  assert.equal((await api.post('/api/pbx/extensions', { data: { number: '1501', display_name: 'E2E Third' } })).status(), 201);
  for (const u of Object.values(USERS)) {
    assert.equal((await api.post('/api/users', { data: { username: u.username, password: PASSWORD, role: 'operator', extension: u.extension } })).status(), 201);
  }
  await settle();
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try { await cleanup(); } catch { /* best effort */ }
  await api?.dispose();
});

describe('call handling in real browsers', { concurrency: false }, () => {
  let A; let B; let C;

  test('three operators register', async () => {
    A = await operator(USERS.a);
    B = await operator(USERS.b);
    C = await operator(USERS.c);
  });

  test('do not disturb: switched on from the dashboard, the caller gets busy and the phone never rings', async () => {
    await B.page.click('#my-dnd');
    await B.page.waitForSelector('#my-handling .banner.warn');
    await settle();
    await dial(A, '1002');
    await waitNoCall(A, 15000);
    await neverRings(B, 1500);
    await B.page.click('#my-dnd');
    await B.page.waitForFunction(() => !document.querySelector('#my-handling .banner.warn'));
    await settle();
    // Back to normal: it rings again.
    await dial(A, '1002');
    await waitIncoming(B);
    await endAll(A, B);
  });

  test('forward all calls: chosen on the dashboard, the call rings the other extension instead', async () => {
    await B.page.selectOption('#my-forward', '1501');
    await B.page.waitForFunction(() => document.querySelector('#my-forward')?.value === '1501');
    await settle();
    await dial(A, '1002');
    await waitIncoming(C);
    await neverRings(B, 1500);
    await answer(C);
    await waitConnected(A);
    await waitConnected(C);
    await endAll(A, C);
    await B.page.selectOption('#my-forward', '');
    await settle();
  });

  test('forward on no answer: 1002 rings first, then the call moves to 1501 after the ring time', async () => {
    await patchExt('1002', { fwd_noanswer: { type: 'extension', value: '1501' }, noanswer_secs: 5 });
    await settle();
    await dial(A, '1002');
    await waitIncoming(B);
    await neverRings(C, 2500);
    await waitIncoming(C, 10000);
    await answer(C);
    await waitConnected(A);
    await endAll(A, B, C);
    await patchExt('1002', { fwd_noanswer: null, noanswer_secs: 25 });
    await settle();
  });

  test('forward when busy: a second caller is sent to 1501 while 1002 is on a call', async () => {
    await patchExt('1002', { fwd_busy: { type: 'extension', value: '1501' } });
    await settle();
    await dial(C, '1002');
    await waitIncoming(B);
    await answer(B);
    await waitConnected(C);
    // A third caller: 1002 is busy, so the call is forwarded to the extension in the busy rule (1501, which is on the call).
    // 1501 is busy too, so the caller hears busy: nothing connects and nobody gets a second ringing call.
    await dial(A, '1002');
    await waitNoCall(A, 15000);
    await endAll(B, C);
    await patchExt('1002', { fwd_busy: null });
    await settle();
  });

  test('ring group (all at once): every member rings, the first to answer gets the call, the others stop', async () => {
    const res = await api.post('/api/pbx/ring-groups', { data: { number: '800', name: NAMES.rg[0], strategy: 'ringall', ring_secs: 20, members: ['1002', '1501'] } });
    assert.equal(res.status(), 201);
    await settle();
    await dial(A, '800');
    await waitIncoming(B);
    await waitIncoming(C);
    await answer(C);
    await waitConnected(A);
    await waitNoCall(B, 8000);
    await endAll(A, C);
  });

  test('ring group (in order): the first member rings alone, then the next one after the ring time', async () => {
    const res = await api.post('/api/pbx/ring-groups', { data: { number: '801', name: NAMES.rg[1], strategy: 'sequential', ring_secs: 5, members: ['1501', '1002'], fail_dest: { type: 'extension', value: '1002' } } });
    assert.equal(res.status(), 201);
    await settle();
    await dial(A, '801');
    await waitIncoming(C);
    await neverRings(B, 3000);
    await waitIncoming(B, 10000);
    await answer(B);
    await waitConnected(A);
    await endAll(A, B, C);
  });

  test('ring groups skip people on do not disturb', async () => {
    await patchExt('1002', { dnd: true });
    await settle();
    await dial(A, '800');
    await waitIncoming(C);
    await neverRings(B, 1500);
    await endAll(A, C);
    await patchExt('1002', { dnd: false });
    await settle();
  });

  test('time condition: an outside call is sent to 1501 when open and to 1002 when closed; the override buttons and holidays decide', async () => {
    await patchExt('1001', { allow_outbound: true });
    assert.equal((await api.post('/api/pbx/trunks', { data: { name: 'e2e-cf', display_name: 'E2E loop', auth_mode: 'ip', host: '127.0.0.1', codecs: ['ulaw'] } })).status(), 201);
    const trunk = (await j(await api.get('/api/pbx/trunks'))).trunks.find((t) => t.name === 'e2e-cf');
    const now = new Date();
    const tc = await api.post('/api/pbx/time-conditions', {
      data: {
        name: NAMES.tc, timezone: 'UTC',
        rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '23:59' }],
        match_dest: { type: 'extension', value: '1501' }, nomatch_dest: { type: 'extension', value: '1002' },
      },
    });
    assert.equal(tc.status(), 201);
    const tcId = (await tc.json()).condition.id;
    assert.equal((await api.post('/api/pbx/inbound-routes', { data: { name: 'E2E hours route', did: DID, trunk_id: trunk.id, destination: { type: 'timecondition', value: String(tcId) } } })).status(), 201);
    assert.equal((await api.post('/api/pbx/outbound-routes', { data: { name: 'E2E out', patterns: ['_9X.'], strip: 1, trunks: [trunk.id] } })).status(), 201);
    await settle();

    // Auto, schedule covers the whole day: open -> 1501 (skipped for the single minute 23:59 UTC).
    if (!(now.getUTCHours() === 23 && now.getUTCMinutes() === 59)) {
      await dial(A, `9${DID}`);
      await waitIncoming(C, 15000);
      await neverRings(B, 1000);
      await endAll(A, C);
    }

    // The override buttons in the UI (Call flow page), as an administrator would use them.
    const admin = await chromium.launch({ args: FLAGS });
    open.push(admin);
    const page = await (await admin.newContext()).newPage();
    await page.goto(`${BASE}/`);
    await page.fill('#username', 'admin');
    await page.fill('#password', ADMIN_PASSWORD);
    await page.click('button[type=submit]');
    await page.click('nav a[href="#/callflow"]');
    await page.waitForSelector('h1:text-is("Call flow")');
    const row = page.locator('table.data tbody tr', { hasText: NAMES.tc });
    await row.locator('button[data-override="closed"]').click();
    await page.waitForSelector(`tr:has-text("${NAMES.tc}") button[data-override="closed"].primary`);
    await settle();
    await dial(A, `9${DID}`);
    await waitIncoming(B, 15000);
    await neverRings(C, 1000);
    await endAll(A, B);

    await page.locator('table.data tbody tr', { hasText: NAMES.tc }).locator('button[data-override="open"]').click();
    await page.waitForSelector(`tr:has-text("${NAMES.tc}") button[data-override="open"].primary`);
    await settle();
    await dial(A, `9${DID}`);
    await waitIncoming(C, 15000);
    await endAll(A, C);

    // Auto again, but today is a holiday: the schedule is ignored and the closed destination wins.
    const patchTc = await api.patch(`/api/pbx/time-conditions/${tcId}`, { data: { override: 'auto', holidays: [{ month: now.getUTCMonth() + 1, day: now.getUTCDate(), name: 'Today' }] } });
    assert.equal(patchTc.status(), 200);
    await settle();
    await dial(A, `9${DID}`);
    await waitIncoming(B, 15000);
    await neverRings(C, 1000);
    await endAll(A, B);
  });

  test('call history records the forwarded and grouped calls without script errors anywhere', async () => {
    const calls = await j(await api.get('/api/cdr?pageSize=100'));
    assert.ok(calls.items.some((r) => r.dst === '800'), 'ring group call recorded');
    assert.ok(calls.items.some((r) => r.dst === '1002'));
    for (const p of [A, B, C]) assert.deepEqual(p.problems, []);
  });
});
