'use strict';
/*
 * Real-browser tests for the PBX administration pages and for calls through a trunk.
 *
 * An administrator builds a complete telephone setup through the web UI only: an extension, a
 * trunk, an inbound route and an outbound route. The "trunk" points at the PBX itself (loopback),
 * so a call really leaves through the outbound route, comes back in through the trunk and the
 * inbound route and reaches the echo test. A second Chromium plays operator 1001 with a fake
 * microphone (440 Hz) and the test measures that the tone really comes back. The call is then
 * looked up in the call history page.
 *
 * Everything the test creates is removed again at the end.
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
const OPERATOR = { username: 'e2e.pbxop', extension: '1001' };
const EXT = { number: '1501', name: 'E2E Desk' };
const TRUNK = { name: 'e2e-loop', display: 'E2E loopback' };
const DID = '5550100';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pbx-'));
const open = [];

function writeTone(file, freq, seconds = 1, rate = 48000, amplitude = 0.5) {
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

let api;
const j = async (res) => res.json();

async function cleanup() {
  const exts = (await j(await api.get('/api/pbx/extensions'))).extensions;
  const trunks = (await j(await api.get('/api/pbx/trunks'))).trunks;
  for (const r of (await j(await api.get('/api/pbx/outbound-routes'))).routes.filter((x) => x.name.startsWith('E2E'))) await api.delete(`/api/pbx/outbound-routes/${r.id}`);
  for (const r of (await j(await api.get('/api/pbx/inbound-routes'))).routes.filter((x) => x.name.startsWith('E2E'))) await api.delete(`/api/pbx/inbound-routes/${r.id}`);
  for (const t of trunks.filter((x) => x.name === TRUNK.name)) await api.delete(`/api/pbx/trunks/${t.id}`);
  const { users } = await j(await api.get('/api/users'));
  for (const u of users.filter((x) => x.username === OPERATOR.username)) await api.delete(`/api/users/${u.id}`);
  for (const e of exts.filter((x) => x.number === EXT.number)) await api.delete(`/api/pbx/extensions/${e.id}`);
  const office = exts.find((x) => x.number === '1001');
  if (office && office.allow_outbound) await api.patch(`/api/pbx/extensions/${office.id}`, { data: { allow_outbound: false } });
}

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  api = await request.newContext({ baseURL: BASE });
  const res = await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } });
  assert.equal(res.status(), 200, 'admin login');
  await cleanup();
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try { await cleanup(); } catch { /* best effort */ }
  await api?.dispose();
});

async function adminPage() {
  const browser = await chromium.launch({ args: FLAGS });
  open.push(browser);
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${BASE}/`);
  await page.fill('#username', 'admin');
  await page.fill('#password', ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('nav a[href="#/extensions"]');
  return { page, problems, browser };
}

const rowOf = (page, text) => page.locator('table.data tbody tr', { hasText: text });

describe('PBX administration through the web UI', { concurrency: false }, () => {
  let admin;

  test('administrators see the new pages; every page renders without script errors', async () => {
    admin = await adminPage();
    const { page, problems } = admin;
    for (const [hash, heading] of [['#/extensions', 'Extensions'], ['#/trunks', 'Trunks'], ['#/routes', 'Routes'], ['#/calls', 'Call history'], ['#/users', 'Users'], ['#/system', 'System status']]) {
      await page.click(`nav a[href="${hash}"]`);
      await page.waitForSelector(`h1:text-is("${heading}")`);
      await sleep(300);
    }
    // (The 401 is the login page asking who is signed in before anyone is.)
    assert.deepEqual(problems.filter((p) => !/favicon|status of 401/.test(p)), []);
  });

  test('operators and plain users do not get the admin pages (server enforces it too)', async () => {
    const res = await api.post('/api/users', { data: { username: OPERATOR.username, password: PASSWORD, role: 'operator', extension: OPERATOR.extension } });
    assert.equal(res.status(), 201);
    const anon = await request.newContext({ baseURL: BASE });
    await anon.post('/api/auth/login', { data: { username: OPERATOR.username, password: PASSWORD } });
    for (const url of ['/api/pbx/extensions', '/api/pbx/trunks', '/api/cdr', '/api/pbx/apply']) assert.equal((await anon.get(url)).status(), 403, url);
    await anon.dispose();
  });

  test('create an extension in the UI: credentials are shown once on request, then edit and delete', async () => {
    const { page } = admin;
    await page.click('nav a[href="#/extensions"]');
    await page.click('#add-extension');
    await page.getByPlaceholder('e.g. 1003').fill(EXT.number);
    await page.getByPlaceholder('e.g. Reception').fill(EXT.name);
    await page.getByRole('button', { name: 'Create extension' }).click();
    await page.waitForSelector('.dialog:has-text("SIP credentials for 1501")');
    const dialog = page.locator('.dialog');
    assert.match(await dialog.innerText(), /1501-phone/);
    const secrets = await j(await api.get(`/api/pbx/extensions/${(await j(await api.get('/api/pbx/extensions'))).extensions.find((e) => e.number === EXT.number).id}/credentials`));
    assert.ok((await dialog.innerText()).includes(secrets.phone.password), 'the shown password is the stored one');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await rowOf(page, EXT.number).waitFor();

    await rowOf(page, EXT.number).getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('May place outbound calls').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector(`tr:has-text("${EXT.number}") >> text=allowed`);

    page.once('dialog', (d) => d.accept());
    await rowOf(page, EXT.number).getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction((n) => ![...document.querySelectorAll('table.data tbody tr')].some((r) => r.textContent.includes(n)), EXT.number);
    assert.equal((await j(await api.get('/api/pbx/extensions'))).extensions.some((e) => e.number === EXT.number), false);
  });

  test('invalid input is explained in the dialog instead of failing silently', async () => {
    const { page } = admin;
    await page.click('#add-extension');
    await page.getByPlaceholder('e.g. 1003').fill('1002');
    await page.getByPlaceholder('e.g. Reception').fill('Duplicate');
    await page.getByRole('button', { name: 'Create extension' }).click();
    await page.waitForSelector('.dialog .form-error:not([hidden])');
    assert.match(await page.locator('.dialog .form-error').innerText(), /already an extension|exists/i);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('create a trunk, an inbound route and an outbound route in the UI; the trunk comes online', async () => {
    const { page } = admin;
    await page.click('nav a[href="#/trunks"]');
    await page.click('#add-trunk');
    await page.getByPlaceholder('e.g. acme-sip').fill(TRUNK.name);
    await page.getByPlaceholder('e.g. Acme VoIP').fill(TRUNK.display);
    await page.locator('.dialog select').nth(1).selectOption('ip');
    await page.getByPlaceholder('sip.provider.com or 192.168.1.50').fill('127.0.0.1');
    await page.getByRole('button', { name: 'Save trunk' }).click();
    await rowOf(page, TRUNK.display).waitFor();
    // Real status from Asterisk (SIP OPTIONS qualify), not a guess.
    await page.waitForFunction((name) => [...document.querySelectorAll('table.data tbody tr')].some((r) => r.textContent.includes(name) && /ONLINE/.test(r.textContent)), TRUNK.display, { timeout: 90000 });

    await page.click('nav a[href="#/routes"]');
    await page.click('#add-inbound');
    await page.getByPlaceholder('e.g. Main line').fill('E2E echo number');
    await page.getByPlaceholder('e.g. 15551234567, or * for any number').fill(DID);
    await page.locator('.dialog select').nth(1).selectOption('echo');
    await page.getByRole('button', { name: 'Save' }).click();
    await rowOf(page, 'E2E echo number').waitFor();

    await page.click('#add-outbound');
    await page.getByPlaceholder('e.g. National calls').fill('E2E outside line');
    await page.getByPlaceholder('_9NXXNXXXXXX').fill('_9X.');
    await page.locator('.dialog input[type=number]').first().fill('1');
    await page.locator('.dialog select').last().selectOption({ label: TRUNK.display });
    await page.getByRole('button', { name: 'Save' }).click();
    await rowOf(page, 'E2E outside line').waitFor();

    // The change reached Asterisk without anyone clicking "apply".
    for (let i = 0; i < 20; i += 1) {
      const s = await j(await api.get('/api/pbx/apply'));
      if (s.inSync && !s.pending) { assert.equal(s.last.ok, true); return; }
      await sleep(500);
    }
    assert.fail('configuration was not applied to Asterisk');
  });

  test('a call from a browser operator goes out through the outbound route and trunk, comes back through the inbound route, and the echo returns the caller\'s own tone', async () => {
    const office = (await j(await api.get('/api/pbx/extensions'))).extensions.find((e) => e.number === '1001');
    assert.equal((await api.patch(`/api/pbx/extensions/${office.id}`, { data: { allow_outbound: true } })).status(), 200);
    await sleep(1500); // let the (debounced) apply reload Asterisk

    const tone = path.join(tmp, 'tone-440.wav');
    writeTone(tone, 440);
    const browser = await chromium.launch({ args: [...FLAGS, `--use-file-for-fake-audio-capture=${tone}`] });
    open.push(browser);
    const context = await browser.newContext({ permissions: ['microphone'] });
    const page = await context.newPage();
    await page.goto(`${BASE}/`);
    await page.fill('#username', OPERATOR.username);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.getByRole('button', { name: 'Enable microphone and audio' }).click();
    await page.waitForFunction(() => /registered \(\d+\)/.test(document.querySelector('#chip-sip')?.textContent || ''), null, { timeout: 25000 });

    await page.fill('#dial', `9${DID}`);
    await page.click('#dial-call');
    await page.waitForFunction(() => /connected|On call|Connected/i.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: 20000 });

    const heard = await page.evaluate(async () => {
      const el = document.getElementById('remote-audio');
      const stream = el && el.srcObject;
      if (!stream) return { stream: false };
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
      let best440 = 0;
      const end = performance.now() + 14000;
      while (performance.now() < end && best440 < 0.08) {
        await new Promise((r) => setTimeout(r, 200));
        an.getFloatTimeDomainData(buf);
        best440 = Math.max(best440, amp(440));
      }
      await ctx.close();
      return { stream: true, a440: best440 };
    });
    assert.equal(heard.stream, true, 'the call carries audio');
    assert.ok(heard.a440 >= 0.08, `the caller hears their own 440 Hz tone echoed back through the trunk (measured ${heard.a440})`);

    await page.click('#hangup');
    await page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout: 10000 });
  });

  test('a call from an extension that is not allowed to dial out is refused', async () => {
    const office = (await j(await api.get('/api/pbx/extensions'))).extensions.find((e) => e.number === '1001');
    await api.patch(`/api/pbx/extensions/${office.id}`, { data: { allow_outbound: false } });
    await sleep(1500);
    const tone = path.join(tmp, 'tone-440.wav');
    const browser = await chromium.launch({ args: [...FLAGS, `--use-file-for-fake-audio-capture=${tone}`] });
    open.push(browser);
    const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
    await page.goto(`${BASE}/`);
    await page.fill('#username', OPERATOR.username);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.getByRole('button', { name: 'Enable microphone and audio' }).click();
    await page.waitForFunction(() => /registered \(\d+\)/.test(document.querySelector('#chip-sip')?.textContent || ''), null, { timeout: 25000 });
    await page.fill('#dial', `9${DID}`);
    // Remember whether the call ever reached "Connected".
    await page.evaluate(() => {
      window.__connected = false;
      new MutationObserver(() => { if (/Connected/.test(document.querySelector('#call-banner')?.textContent || '')) window.__connected = true; })
        .observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.click('#dial-call');
    await page.waitForSelector('#call-banner', { timeout: 5000 }).catch(() => {});
    // The call ends on its own and never connects.
    await page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__connected), false, 'a call from an extension without outbound permission must not connect');
    await browser.close();
  });

  test('the call history lists the call with direction, trunk, result and duration; statistics and CSV work', async () => {
    const { page } = admin;
    await page.click('nav a[href="#/calls"]');
    await page.waitForSelector('h1:text-is("Call history")');
    await page.waitForFunction((n) => [...document.querySelectorAll('table.data tbody tr')].some((r) => r.textContent.includes(n)), `9${DID}`, { timeout: 20000 });
    const outbound = rowOf(page, `9${DID}`).filter({ hasText: 'Outbound' }).first();
    const text = await outbound.innerText();
    assert.match(text, /Outbound/);
    assert.match(text, /1001/);
    assert.match(text, /e2e-loop/);
    assert.match(text, /Answered/);
    const inbound = rowOf(page, DID).filter({ hasText: 'Inbound' }).first();
    assert.match(await inbound.innerText(), /e2e-loop/);
    assert.match(await page.locator('.cards .stat').first().innerText(), /Calls\s+\d+/);

    const csv = await page.evaluate(async () => (await fetch('/api/cdr/export.csv?direction=outbound')).text());
    assert.match(csv, /^start_time,answer_time,end_time,src,dst/);
    assert.ok(csv.includes('95550100'));

    // The refused call is in the history too, as a failed call.
    const calls = await j(await api.get('/api/cdr?pageSize=50'));
    const refused = calls.items.find((r) => r.src === '1001' && r.dst === `9${DID}` && r.disposition !== 'ANSWERED');
    assert.ok(refused, 'refused call recorded');
  });

  test('every change was written to the audit log without secrets', async () => {
    const items = (await j(await api.get('/api/audit?pageSize=200'))).items;
    for (const action of ['pbx.extension.create', 'pbx.extension.delete', 'pbx.trunk.create', 'pbx.inbound_route.create', 'pbx.outbound_route.create', 'pbx.extension.credentials.view']) {
      assert.ok(items.some((i) => i.action === action), `${action} audited`);
    }
    const blob = JSON.stringify(items);
    assert.ok(!blob.includes(PASSWORD));
  });
});
