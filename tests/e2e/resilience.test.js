/**
 * Resilience tests with REAL outages. The host script scripts/test-resilience.sh stops and starts
 * the backend and Asterisk containers; this file drives real Chromium browsers through each step
 * and checks what the user sees. The two sides synchronise through files in /sync:
 *   <step>.ready  written by this test when the browsers are in place for the action
 *   <step>.go     written by the host script once the action has been carried out
 *
 *   1. backend stopped  -> "Cannot reach the server" banner, paging refused with a clear error
 *   2. backend started  -> banner clears on its own, live updates resume
 *   3. Asterisk stopped -> admin sees the AMI-disconnected banner, extension state Unknown
 *   4. Asterisk started -> the banner clears, the browser softphone re-registers by itself
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
const SYNC = process.env.SYNC_DIR || '/sync';
const OPERATOR = { username: 'e2e.resilience', role: 'operator', extension: '1001' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'));
const open = [];
let api;

async function step(name, timeoutMs = 240000) {
  fs.writeFileSync(path.join(SYNC, `${name}.ready`), '');
  const go = path.join(SYNC, `${name}.go`);
  const end = Date.now() + timeoutMs;
  while (!fs.existsSync(go)) {
    if (Date.now() > end) throw new Error(`host did not complete step "${name}" in time`);
    await sleep(500);
  }
}

function writeTone(file) {
  const rate = 48000; const n = rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

async function launch() {
  const tone = path.join(tmp, 'tone.wav');
  writeTone(tone);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', `--use-file-for-fake-audio-capture=${tone}`] });
  open.push(browser);
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return { browser, page, problems };
}

const chip = (page, id) => page.locator(`#${id}`).innerText();
const waitText = (page, selector, re, timeout) =>
  page.waitForFunction(([sel, src]) => new RegExp(src, 'i').test(document.querySelector(sel)?.textContent || ''), [selector, re.source], { timeout });
const waitBodyText = (page, re, timeout) =>
  page.waitForFunction((src) => new RegExp(src, 'i').test(document.body.innerText), re.source, { timeout });
const waitNoBodyText = (page, re, timeout) =>
  page.waitForFunction((src) => !new RegExp(src, 'i').test(document.body.innerText), re.source, { timeout });
const state = (page, ext) => page.locator(`article[data-extension="${ext}"] .badge`).getAttribute('data-state');

let admin;
let op;

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  api = await request.newContext({ baseURL: BASE });
  assert.equal((await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })).status(), 200);
  const { users } = await (await api.get('/api/users')).json();
  for (const u of users.filter((x) => x.username === OPERATOR.username)) await api.delete(`/api/users/${u.id}`);
  const created = await api.post('/api/users', { data: { ...OPERATOR, password: PASSWORD } });
  assert.equal(created.status(), 201, await created.text());
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try {
    const { users } = await (await api.get('/api/users')).json();
    for (const u of users.filter((x) => x.username === OPERATOR.username)) await api.delete(`/api/users/${u.id}`);
  } catch { /* best effort */ }
  await api?.dispose();
});

describe('outages seen from real browsers', { concurrency: false }, () => {
  test('both browsers start healthy: live, AMI connected, softphone registered', async () => {
    admin = await launch();
    await admin.page.goto(`${BASE}/`);
    await admin.page.fill('#username', 'admin');
    await admin.page.fill('#password', ADMIN_PASSWORD);
    await admin.page.click('button[type=submit]');
    await waitText(admin.page, '#chip-server', /^Live$/, 15000);
    await waitText(admin.page, '#chip-ami', /Telephony connected/, 15000);

    op = await launch();
    await op.page.goto(`${BASE}/`);
    await op.page.fill('#username', OPERATOR.username);
    await op.page.fill('#password', PASSWORD);
    await op.page.click('button[type=submit]');
    await op.page.getByRole('button', { name: 'Enable microphone and audio' }).click();
    await op.page.waitForFunction(() => /registered \(\d+\)/.test(document.querySelector('#chip-sip')?.textContent || ''), null, { timeout: 25000 });
    await op.page.waitForFunction(() => document.querySelector('article[data-extension="1001"] .badge')?.getAttribute('data-state') === 'Online', null, { timeout: 15000 });
    assert.equal(await state(admin.page, '1001'), 'Online');
  });

  test('backend stopped: a clear "cannot reach the server" state, and paging is refused with an error, not silence', async () => {
    await step('backend-down');
    await waitBodyText(admin.page, /Cannot reach the server/, 60000);
    assert.match(await chip(admin.page, 'chip-server'), /unreachable|Reconnecting/i);
    await waitBodyText(op.page, /Cannot reach the server/, 60000);
    await op.page.locator('button[data-group="702"]').click();
    await op.page.waitForSelector('.toast.error', { timeout: 15000 });
    assert.equal(await op.page.locator('#call-banner').count(), 0, 'no call was placed');
  });

  test('backend started again: the banner clears by itself and live updates resume', async () => {
    await step('backend-up');
    await waitNoBodyText(admin.page, /Cannot reach the server/, 60000);
    await waitText(admin.page, '#chip-server', /^Live$/, 60000);
    await waitText(admin.page, '#chip-ami', /Telephony connected/, 30000);
    assert.equal(await state(admin.page, '1001'), 'Online');
    assert.match(await op.page.locator('#chip-sip').innerText(), /registered/i, 'the SIP registration is independent of the backend and was never lost');
  });

  test('Asterisk stopped: administrators see AMI disconnected, state is Unknown (not guessed), paging is refused', async () => {
    await step('ami-down');
    await waitBodyText(admin.page, /telephony system \(Asterisk AMI\) is disconnected/, 60000);
    assert.match(await chip(admin.page, 'chip-ami'), /DISCONNECTED/);
    await admin.page.waitForFunction(() => document.querySelector('article[data-extension="1001"] .badge')?.getAttribute('data-state') === 'Unknown', null, { timeout: 30000 });
    await op.page.waitForFunction(() => document.querySelector('article[data-extension="1001"] .badge')?.getAttribute('data-state') === 'Unknown', null, { timeout: 30000 });
    // The browser phone loses its registration with Asterisk, so paging is switched off with a reason.
    await op.page.waitForFunction(() => !/registered (d+)/.test(document.querySelector('#chip-sip')?.textContent || ''), null, { timeout: 60000 });
    await op.page.waitForFunction(() => document.querySelector('button[data-group="702"]')?.disabled === true, null, { timeout: 15000 });
    assert.match(await op.page.locator('button[data-group="702"]').getAttribute('title'), /not registered/i);
    assert.equal(await op.page.locator('#call-banner').count(), 0, 'no call was placed');
  });

  test('Asterisk started again: the banner clears and the browser softphone re-registers on its own', async () => {
    await step('ami-up');
    await waitNoBodyText(admin.page, /telephony system \(Asterisk AMI\) is disconnected/, 60000);
    await waitText(admin.page, '#chip-ami', /Telephony connected/, 30000);
    await op.page.waitForFunction(() => /registered \(\d+\)/.test(document.querySelector('#chip-sip')?.textContent || ''), null, { timeout: 90000 });
    await admin.page.waitForFunction(() => document.querySelector('article[data-extension="1001"] .badge')?.getAttribute('data-state') === 'Online', null, { timeout: 60000 });
    assert.equal(await state(admin.page, '1001'), 'Online');
  });

  test('no unexpected JavaScript errors occurred', async () => {
    assert.deepEqual(admin.problems, []);
    assert.deepEqual(op.problems, []);
  });
});
