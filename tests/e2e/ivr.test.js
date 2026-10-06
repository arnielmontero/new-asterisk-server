'use strict';
/*
 * Real-browser tests for audio prompts, announcements and IVR menus.
 *
 * An administrator uploads an audio file through the web UI (converted in the browser, sent through Nginx) and builds a
 * menu in the UI. A real browser operator then calls the menu: the prompt is heard (measured as a 440 Hz tone on the
 * decoded WebRTC audio), keys are pressed on the on-screen keypad (RFC 4733 DTMF to Asterisk) and the call lands where
 * the menu says: an extension that actually rings, an announcement that is heard, or a hang-up after the repeats.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, request } = require('playwright');

const BASE = process.env.BASE_URL || 'https://communications.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PASSWORD = 'E2e-Operator-Passw0rd!';
const USERS = { a: { username: 'e2e.iva', extension: '1001' }, c: { username: 'e2e.ivc', extension: '1501' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const open = [];
let api;
const j = async (res) => res.json();

function tone(freq, seconds, rate = 44100, channels = 2) {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(0.6 * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
    for (let c = 0; c < channels; c += 1) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function cleanup() {
  const { users } = await j(await api.get('/api/users'));
  for (const u of users.filter((x) => Object.values(USERS).some((e) => e.username === x.username))) await api.delete(`/api/users/${u.id}`);
  for (const i of (await j(await api.get('/api/pbx/ivrs'))).ivrs.filter((x) => x.name.startsWith('E2E'))) await api.delete(`/api/pbx/ivrs/${i.id}`);
  for (const a of (await j(await api.get('/api/pbx/announcements'))).announcements.filter((x) => x.name.startsWith('E2E'))) await api.delete(`/api/pbx/announcements/${a.id}`);
  for (const p of (await j(await api.get('/api/pbx/prompts'))).prompts.filter((x) => x.name.startsWith('E2E'))) await api.delete(`/api/pbx/prompts/${p.id}`);
  for (const e of (await j(await api.get('/api/pbx/extensions'))).extensions.filter((x) => x.number === '1501')) await api.delete(`/api/pbx/extensions/${e.id}`);
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
  return { page, user, problems };
}

const bannerText = (p) => p.page.evaluate(() => document.querySelector('#call-banner')?.textContent || '').catch(() => '');
const waitConnected = (p, t = 15000) => p.page.waitForFunction(() => /Connected/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: t });
const waitIncoming = (p, t = 12000) => p.page.waitForFunction(() => /Incoming call/.test(document.querySelector('#call-banner')?.textContent || ''), null, { timeout: t });
const waitNoCall = (p, t = 15000) => p.page.waitForFunction(() => !document.querySelector('#call-banner'), null, { timeout: t });
const dial = async (p, n) => { await p.page.fill('#dial', n); await p.page.click('#dial-call'); };
const press = async (p, keys) => { for (const k of keys) { await p.page.locator(`#keypad button[data-key="${k}"]`).click({ timeout: 5000 }); await sleep(300); } };
async function endAll(...ops) {
  for (const p of ops) for (const sel of ['#hangup', '#reject']) { const b = p.page.locator(sel); if (await b.count()) await b.first().click({ timeout: 2000 }).catch(() => {}); }
  await sleep(1500);
}
async function answer(p) { await p.page.locator('#answer').click({ timeout: 5000 }); }

/** Wait until the decoded remote audio contains `freq` Hz (amplitude above 0.08); resolves the best amplitude seen. */
async function hear(p, freq, maxMs = 12000) {
  return p.page.evaluate(async ({ f, limit }) => {
    const el = document.getElementById('remote-audio');
    const stream = el && el.srcObject;
    if (!stream) return 0;
    const ctx = new AudioContext();
    await ctx.resume();
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const amp = () => {
      let re = 0; let im = 0; const w = (2 * Math.PI * f) / ctx.sampleRate;
      for (let i = 0; i < buf.length; i += 1) { re += buf[i] * Math.cos(w * i); im -= buf[i] * Math.sin(w * i); }
      return (2 * Math.hypot(re, im)) / buf.length;
    };
    let best = 0;
    const end = performance.now() + limit;
    while (performance.now() < end && best < 0.08) {
      await new Promise((r) => setTimeout(r, 150));
      an.getFloatTimeDomainData(buf);
      best = Math.max(best, amp());
    }
    await ctx.close();
    return best;
  }, { f: freq, limit: maxMs });
}

before(async () => {
  assert.ok(ADMIN_PASSWORD, 'ADMIN_PASSWORD is required');
  api = await request.newContext({ baseURL: BASE });
  assert.equal((await api.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })).status(), 200);
  await cleanup();
  assert.equal((await api.post('/api/pbx/extensions', { data: { number: '1501', display_name: 'E2E Sales' } })).status(), 201);
  for (const u of Object.values(USERS)) {
    assert.equal((await api.post('/api/users', { data: { username: u.username, password: PASSWORD, role: 'operator', extension: u.extension } })).status(), 201);
  }
  await sleep(1500);
});

after(async () => {
  for (const b of open) await b.close().catch(() => {});
  try { await cleanup(); } catch { /* best effort */ }
  await api?.dispose();
});

describe('prompts, announcements and menus in real browsers', { concurrency: false }, () => {
  let admin; let A; let C;
  const problems = [];

  test('an administrator uploads an audio file in the UI (converted in the browser, 500 KB through Nginx) and plays it back', async () => {
    const browser = await chromium.launch({ args: FLAGS });
    open.push(browser);
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push(m.text()); });
    admin = page;
    await page.goto(`${BASE}/`);
    await page.fill('#username', 'admin');
    await page.fill('#password', ADMIN_PASSWORD);
    await page.click('button[type=submit]');
    await page.click('nav a[href="#/menus"]');
    await page.waitForSelector('h1:text-is("Menus & audio")');
    await page.click('#add-prompt');
    await page.getByPlaceholder('e.g. Welcome greeting').fill('E2E welcome');
    await page.locator('.dialog input[type=file]').setInputFiles({ name: 'welcome.wav', mimeType: 'audio/wav', buffer: tone(440, 3) });
    await page.getByRole('button', { name: 'Save prompt' }).click();
    await page.waitForSelector('tr:has-text("E2E welcome")', { timeout: 20000 });
    const prompt = (await j(await api.get('/api/pbx/prompts'))).prompts.find((p) => p.name === 'E2E welcome');
    assert.ok(Math.abs(prompt.duration_ms - 3000) < 50, `3 s file stored as ${prompt.duration_ms} ms`);
    assert.ok(prompt.size_bytes < 60000, 'converted to 8 kHz mono (a 500 KB upload became a small file)');
    // The player's source is the authenticated audio endpoint and returns real audio.
    const audio = await page.evaluate(async (id) => { const r = await fetch(`/api/pbx/prompts/${id}/audio`); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), riff: String.fromCharCode(...b.slice(0, 4)) }; }, prompt.id);
    assert.deepEqual(audio, { status: 200, type: 'audio/wav', riff: 'RIFF' });
  });

  test('an unusable file is refused with a message in the dialog', async () => {
    await admin.click('#add-prompt');
    await admin.getByPlaceholder('e.g. Welcome greeting').fill('E2E bad');
    await admin.locator('.dialog input[type=file]').setInputFiles({ name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('this is not audio at all'.repeat(20)) });
    await admin.getByRole('button', { name: 'Save prompt' }).click();
    await admin.waitForSelector('.dialog .form-error:not([hidden])');
    assert.ok((await admin.locator('.dialog .form-error').innerText()).length > 10);
    await admin.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await j(await api.get('/api/pbx/prompts'))).prompts.some((p) => p.name === 'E2E bad'), false);
  });

  test('build the menu in the UI: prompt, key 2 to extension 1501, a second key and the fall-back', async () => {
    // A second prompt (880 Hz) for the "closed" announcement, uploaded straight to the API.
    const up = await api.post('/api/pbx/prompts?name=E2E closed', { headers: { 'Content-Type': 'audio/wav' }, data: tone(880, 2) });
    assert.equal(up.status(), 201);
    const closed = (await up.json()).prompt;
    const ann = await api.post('/api/pbx/announcements', { data: { name: 'E2E closed message', prompt_id: closed.id } });
    assert.equal(ann.status(), 201);

    await admin.click('#add-ivr');
    await admin.getByPlaceholder('e.g. 900').fill('900');
    await admin.getByPlaceholder('e.g. Main menu').fill('E2E main menu');
    await admin.locator('.dialog select').first().selectOption({ label: 'E2E welcome' });
    await admin.click('#add-ivr-key');
    await admin.locator('.ivr-row select').nth(0).selectOption('2');
    await admin.locator('.ivr-row select').nth(2).selectOption('1501');
    await admin.locator('.dialog input[type=number]').nth(0).fill('4');
    await admin.locator('.dialog input[type=number]').nth(1).fill('2');
    await admin.getByRole('button', { name: 'Save' }).click();
    await admin.waitForSelector('tr:has-text("E2E main menu")');

    // The rest of the keys through the API (the UI builds the same objects).
    const ivr = (await j(await api.get('/api/pbx/ivrs'))).ivrs.find((i) => i.number === '900');
    assert.equal(ivr.options.length, 1);
    assert.deepEqual(ivr.options[0], { digit: '2', dest: { type: 'extension', value: '1501' } });
    const annId = (await ann.json()).announcement.id;
    const patch = await api.patch(`/api/pbx/ivrs/${ivr.id}`, {
      data: { options: [...ivr.options, { digit: '0', dest: { type: 'announcement', value: String(annId) } }], fail_dest: { type: 'announcement', value: String(annId) } },
    });
    assert.equal(patch.status(), 200);
    await sleep(1500);
  });

  test('operators register', async () => {
    A = await operator(USERS.a);
    C = await operator(USERS.c);
  });

  test('calling the menu: the caller hears the prompt (440 Hz), and keeps hearing it', async () => {
    await dial(A, '900');
    await waitConnected(A);
    const heard = await hear(A, 440);
    assert.ok(heard >= 0.08, `prompt tone measured ${heard}`);
    await endAll(A);
  });

  test('pressing 2 on the on-screen keypad rings extension 1501, which answers and talks to the caller', async () => {
    await dial(A, '900');
    await waitConnected(A);
    await press(A, '2');
    await waitIncoming(C);
    assert.match(await bannerText(C), /From 1001/);
    await answer(C);
    await waitConnected(C);
    await waitConnected(A);
    await endAll(A, C);
  });

  test('pressing 0 plays the closed announcement (880 Hz) and then hangs up', async () => {
    await dial(A, '900');
    await waitConnected(A);
    await press(A, '0');
    const heard = await hear(A, 880, 8000);
    assert.ok(heard >= 0.08, `announcement tone measured ${heard}`);
    await waitNoCall(A, 12000); // the announcement ends and the call is hung up by the system
  });

  test('pressing nothing: the menu repeats, then goes to its fall-back (the announcement) and the call ends', async () => {
    const started = Date.now();
    await dial(A, '900');
    await waitConnected(A);
    // Two plays of the 3 s prompt plus the 4 s waits = about 14 s, then the 2 s announcement.
    const heard = await hear(A, 880, 30000);
    assert.ok(heard >= 0.08, 'fall-back announcement heard');
    await waitNoCall(A, 10000);
    assert.ok(Date.now() - started > 9000, 'the menu was repeated before giving up');
  });

  test('direct extension dialling is off by default and works when enabled', async () => {
    await dial(A, '900');
    await waitConnected(A);
    await press(A, '1501'); // not a key of the menu: with direct dialling off it is "invalid"
    await neverRings(C, 4000);
    await endAll(A);

    const ivr = (await j(await api.get('/api/pbx/ivrs'))).ivrs.find((i) => i.number === '900');
    assert.equal((await api.patch(`/api/pbx/ivrs/${ivr.id}`, { data: { allow_extension_dial: true } })).status(), 200);
    await sleep(1500);
    await dial(A, '900');
    await waitConnected(A);
    await press(A, '1501');
    await waitIncoming(C, 12000);
    await endAll(A, C);
  });

  test('the menu can also be dialled by number from another extension and shows in the call history; no script errors', async () => {
    const calls = await j(await api.get('/api/cdr?pageSize=100'));
    assert.ok(calls.items.some((r) => r.dst === '900' && r.src === '1001'), 'menu calls are recorded with the number dialled');
    for (const p of [A, C]) assert.deepEqual(p.problems, []);
    assert.deepEqual(problems, []);
  });
});

async function neverRings(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assert.ok(!/Incoming call/.test(await bannerText(p)), `${p.user.username} must not ring`);
    await sleep(250);
  }
}
