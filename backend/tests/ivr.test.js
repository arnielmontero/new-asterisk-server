'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness, auditCount } = require('./helpers');
const { toTelephonyWav, parseWav } = require('../src/pbx/wav');
const { renderDialplan } = require('../src/pbx/render');

/** A sine tone as a WAV file: any rate, channel count and sample format. */
function makeWav({ seconds = 1, rate = 44100, channels = 2, bits = 16, float = false, freq = 440 } = {}) {
  const frames = Math.round(seconds * rate);
  const bytes = bits / 8;
  const data = Buffer.alloc(frames * channels * bytes);
  for (let i = 0; i < frames; i += 1) {
    const v = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
    for (let c = 0; c < channels; c += 1) {
      const o = (i * channels + c) * bytes;
      if (float) data.writeFloatLE(v, o);
      else if (bits === 8) data[o] = Math.round(v * 127 + 128);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), o);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), o, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), o);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(float ? 3 : 1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * bytes, 28); h.writeUInt16LE(channels * bytes, 32); h.writeUInt16LE(bits, 34); h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Frequency of the strongest of a few candidate tones in an 8 kHz mono 16-bit WAV. */
function strongestOf(wav, candidates) {
  const n = (wav.length - 44) / 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i += 1) s[i] = wav.readInt16LE(44 + i * 2) / 32768;
  const amp = (f) => { let re = 0; let im = 0; const w = (2 * Math.PI * f) / 8000; for (let i = 0; i < n; i += 1) { re += s[i] * Math.cos(w * i); im -= s[i] * Math.sin(w * i); } return (2 * Math.hypot(re, im)) / n; };
  return candidates.map((f) => [f, amp(f)]).sort((a, b) => b[1] - a[1])[0];
}

describe('WAV conversion to telephone format', () => {
  test('stereo 44.1 kHz becomes mono 8 kHz 16-bit and the tone survives', () => {
    const { wav, durationMs } = toTelephonyWav(makeWav({ seconds: 1.5, freq: 440 }));
    const f = parseWav(wav);
    assert.deepEqual([f.sampleRate, f.channels, f.bits, f.format], [8000, 1, 16, 1]);
    assert.ok(Math.abs(durationMs - 1500) <= 5, `duration ${durationMs}`);
    assert.equal(wav.length, 44 + Math.round(1.5 * 8000) * 2);
    const [freq, amplitude] = strongestOf(wav, [300, 440, 880, 1500]);
    assert.equal(freq, 440);
    assert.ok(amplitude > 0.3, `amplitude ${amplitude}`);
  });

  test('other sample formats and rates are accepted', () => {
    for (const opts of [{ bits: 8, channels: 1, rate: 8000 }, { bits: 24, rate: 48000 }, { bits: 32, rate: 16000 }, { float: true, bits: 32, rate: 22050, channels: 1 }, { rate: 6000, channels: 1 }]) {
      const { wav } = toTelephonyWav(makeWav({ seconds: 1, ...opts }));
      const [freq, amplitude] = strongestOf(wav, [300, 440, 880]);
      assert.equal(freq, 440, JSON.stringify(opts));
      assert.ok(amplitude > 0.25, `${JSON.stringify(opts)} amplitude ${amplitude}`);
    }
  });

  test('rubbish, compressed and unreasonable audio is refused with a clear message', () => {
    const bad = {
      'not a wav': Buffer.from('ID3 this is an mp3 header '.repeat(10)),
      'tiny': Buffer.from('RIFF'),
      'empty': Buffer.alloc(0),
      'too short': makeWav({ seconds: 0.05 }),
      'too long': makeWav({ seconds: 301, rate: 8000, channels: 1 }),
    };
    for (const [name, buf] of Object.entries(bad)) {
      assert.throws(() => toTelephonyWav(buf), (e) => e.status === 400 && e.code === 'bad_audio', name);
    }
    const adpcm = makeWav({ seconds: 1 });
    adpcm.writeUInt16LE(2, 20); // MS ADPCM
    assert.throws(() => toTelephonyWav(adpcm), /Unsupported WAV encoding/);
    const noData = makeWav({ seconds: 1 });
    noData.write('junk', 36);
    assert.throws(() => toTelephonyWav(noData), /damaged/);
  });

  test('a truncated file is converted up to where it ends instead of failing', () => {
    const full = makeWav({ seconds: 2, rate: 8000, channels: 1 });
    const { durationMs } = toTelephonyWav(full.subarray(0, 44 + 8000 * 2)); // claims 2 s, holds 1 s
    assert.ok(Math.abs(durationMs - 1000) <= 5);
  });
});

describe('prompts, announcements and menus', () => {
  let h; let admin; let operator;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.ivr', role: 'operator', extension: '1001' });
  });
  after(async () => h.cleanup());

  const post = (url, body, who = admin) => h.agent().post(`/api/pbx${url}`).set(who.auth).send(body);
  const patch = (url, body, who = admin) => h.agent().patch(`/api/pbx${url}`).set(who.auth).send(body);
  const get = (url, who = admin) => h.agent().get(`/api/pbx${url}`).set(who.auth);
  const del = (url, who = admin) => h.agent().delete(`/api/pbx${url}`).set(who.auth);
  const upload = (name, body, who = admin) => h.agent().post(`/api/pbx/prompts?name=${encodeURIComponent(name)}`).set(who.auth).set('Content-Type', 'audio/wav').send(body);

  describe('prompts', () => {
    test('upload converts to telephone format, stores the file and lists it', async () => {
      const res = await upload('Welcome greeting', makeWav({ seconds: 2 }));
      assert.equal(res.status, 201);
      assert.ok(Math.abs(res.body.prompt.duration_ms - 2000) <= 5);
      assert.equal(res.body.prompt.in_use, false);
      const file = h.store.promptFile(res.body.prompt.id);
      const stored = fs.readFileSync(file);
      assert.deepEqual([parseWav(stored).sampleRate, parseWav(stored).channels, parseWav(stored).bits], [8000, 1, 16]);
      assert.equal(stored.length, res.body.prompt.size_bytes);
      const list = (await get('/prompts')).body.prompts;
      assert.equal(list.length, 1);
      assert.ok(!JSON.stringify(list).includes(file), 'server paths are never exposed');
      assert.equal(await auditCount(h.db, "action = 'pbx.prompt.create' AND status = 'success'"), 1);
    });

    test('the audio can be played back through the API (with range support for seeking)', async () => {
      const id = (await get('/prompts')).body.prompts[0].id;
      const res = await h.agent().get(`/api/pbx/prompts/${id}/audio`).set(admin.auth).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /audio\/wav/);
      assert.equal(res.body.toString('ascii', 0, 4), 'RIFF');
      const ranged = await h.agent().get(`/api/pbx/prompts/${id}/audio`).set(admin.auth).set('Range', 'bytes=0-99');
      assert.equal(ranged.status, 206);
      assert.equal((await h.agent().get('/api/pbx/prompts/99999/audio').set(admin.auth)).status, 404);
    });

    test('bad names, bad audio, duplicates, empty and oversized uploads are refused and leave nothing behind', async () => {
      for (const name of ['', 'a;b', 'x"y', 'new\nline', '${x}', 'x'.repeat(61), '../../etc']) {
        assert.equal((await upload(name, makeWav())).status, 400, JSON.stringify(name));
      }
      assert.equal((await h.agent().post('/api/pbx/prompts').set(admin.auth).set('Content-Type', 'audio/wav').send(makeWav())).status, 400, 'name is required');
      const mp3 = await upload('Not wav', Buffer.from('ID3'.repeat(100)));
      assert.equal(mp3.status, 400);
      assert.equal(mp3.body.error.code, 'bad_audio');
      assert.equal((await upload('Empty', Buffer.alloc(0))).status, 400);
      assert.equal((await upload('Welcome greeting', makeWav())).status, 409, 'duplicate name');
      const big = await upload('Big', Buffer.alloc(13 * 1024 * 1024, 1));
      assert.equal(big.status, 413);
      assert.equal((await get('/prompts')).body.prompts.length, 1);
      assert.equal(fs.readdirSync(`${h.mediaDir}/prompts`).length, 1, 'no orphan files');
      assert.ok((await auditCount(h.db, "action = 'pbx.prompt.create' AND status = 'failure'")) >= 3);
    });

    test('rename, and only administrators can touch prompts', async () => {
      const id = (await get('/prompts')).body.prompts[0].id;
      assert.equal((await patch(`/prompts/${id}`, { name: 'Main greeting' })).status, 200);
      assert.equal((await patch(`/prompts/${id}`, { name: 'bad;name' })).status, 400);
      for (const r of [get('/prompts', operator), upload('X', makeWav(), operator), del(`/prompts/${id}`, operator), h.agent().get(`/api/pbx/prompts/${id}/audio`).set(operator.auth)]) {
        assert.equal((await r).status, 403);
      }
      assert.equal((await h.agent().get(`/api/pbx/prompts/${id}/audio`)).status, 401);
    });
  });

  describe('announcements', () => {
    test('create, validate, update; a prompt in use cannot be deleted', async () => {
      const prompt = (await get('/prompts')).body.prompts[0];
      const ok = await post('/announcements', { name: 'Closed message', prompt_id: prompt.id });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.announcement.prompt_name, 'Main greeting');
      assert.equal(ok.body.announcement.next_dest, null);
      assert.equal((await post('/announcements', { name: 'Closed message', prompt_id: prompt.id })).status, 409);
      assert.equal((await post('/announcements', { name: 'Ghost', prompt_id: 9999 })).status, 400);
      assert.equal((await post('/announcements', { name: 'Bad dest', prompt_id: prompt.id, next_dest: { type: 'extension', value: '4242' } })).status, 400);
      assert.equal((await post('/announcements', { name: 'bad;name', prompt_id: prompt.id })).status, 400);
      const blocked = await del(`/prompts/${prompt.id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /announcement "Closed message"/);
      const upd = await patch(`/announcements/${ok.body.announcement.id}`, { next_dest: { type: 'extension', value: '1001' }, enabled: false });
      assert.deepEqual(upd.body.announcement.next_dest, { type: 'extension', value: '1001' });
      assert.equal((await patch(`/announcements/${ok.body.announcement.id}`, { next_dest: { type: 'announcement', value: String(ok.body.announcement.id) } })).status, 400, 'not to itself');
    });

    test('an announcement that something routes to cannot be deleted', async () => {
      const a = (await get('/announcements')).body.announcements[0];
      await post('/trunks', { name: 'ivt', display_name: 'T', auth_mode: 'ip', host: '10.8.8.8' });
      const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'ivt');
      const route = await post('/inbound-routes', { name: 'to ann', did: '5557000', trunk_id: trunk.id, destination: { type: 'announcement', value: String(a.id) } });
      assert.equal(route.status, 201);
      const blocked = await del(`/announcements/${a.id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /inbound route "to ann"/);
      await del(`/inbound-routes/${route.body.route.id}`);
      assert.equal((await del(`/announcements/${a.id}`)).status, 200);
    });
  });

  describe('menus (IVR)', () => {
    const promptId = async () => (await get('/prompts')).body.prompts[0].id;

    test('create with keys, validate everything, share the number space', async () => {
      const ok = await post('/ivrs', {
        number: '900', name: 'Main menu', prompt_id: await promptId(), timeout_secs: 5, max_repeats: 3,
        options: [{ digit: '1', dest: { type: 'extension', value: '1001' } }, { digit: '0', dest: { type: 'echo' } }, { digit: '*', dest: { type: 'ivr', value: '900' } }],
        fail_dest: { type: 'hangup', value: 'busy' }, allow_extension_dial: true,
      });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.ivr.prompt_name, 'Main greeting');
      assert.deepEqual(ok.body.ivr.options.map((o) => o.digit), ['1', '0', '*'], 'a key may lead back to the same menu');
      for (const bad of [
        { number: '901', name: 'x', options: [{ digit: '12', dest: { type: 'echo' } }] },
        { number: '901', name: 'x', options: [{ digit: 'a', dest: { type: 'echo' } }] },
        { number: '901', name: 'x', options: [{ digit: '1', dest: { type: 'echo' } }, { digit: '1', dest: { type: 'echo' } }] },
        { number: '901', name: 'x', options: [{ digit: '1', dest: { type: 'extension', value: '4242' } }] },
        { number: '901', name: 'x', options: [{ digit: '1', dest: { type: 'shell', value: 'rm' } }] },
        { number: '901', name: 'x', prompt_id: 9999 },
        { number: '901', name: 'x', timeout_secs: 1 },
        { number: '901', name: 'x', max_repeats: 9 },
        { number: '901', name: 'x', fail_dest: { type: 'ivr', value: '777' } },
        { number: '901', name: 'x;y' },
        { number: '9', name: 'x' },
        { number: '901', name: 'x', extra: 1 },
        { number: '901', name: 'x', options: Array.from({ length: 13 }, (_, k) => ({ digit: String(k % 10), dest: { type: 'echo' } })) },
      ]) {
        assert.equal((await post('/ivrs', bad)).status, 400, JSON.stringify(bad).slice(0, 100));
      }
      for (const number of ['900', '1001', '700', '600']) assert.equal((await post('/ivrs', { number, name: 'Clash' })).status, 409, number);
      assert.equal((await post('/extensions', { number: '900', display_name: 'Clash' })).status, 409);
      assert.equal((await post('/ring-groups', { number: '900', name: 'Clash', members: ['1001'] })).status, 409);
    });

    test('update keys, a menu cannot fall back to itself, a used prompt is protected', async () => {
      const ivr = (await get('/ivrs')).body.ivrs[0];
      const upd = await patch(`/ivrs/${ivr.id}`, { options: [{ digit: '2', dest: { type: 'extension', value: '1002' } }], timeout_secs: 8 });
      assert.equal(upd.status, 200);
      assert.deepEqual(upd.body.ivr.options, [{ digit: '2', dest: { type: 'extension', value: '1002' } }]);
      assert.equal(upd.body.ivr.timeout_secs, 8);
      assert.equal((await patch(`/ivrs/${ivr.id}`, { fail_dest: { type: 'ivr', value: '900' } })).status, 400);
      assert.equal((await patch(`/ivrs/${ivr.id}`, { prompt_id: null })).status, 200, 'a menu may have no prompt');
      assert.equal((await patch(`/ivrs/${ivr.id}`, {})).status, 400);
      assert.equal((await del(`/prompts/${await promptId()}`)).status, 200, 'unused now, so it can go');
    });

    test('menus are destinations: routes, other menus and forwards use them, and they protect what they use', async () => {
      const ivr = (await get('/ivrs')).body.ivrs[0];
      const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'ivt');
      const route = await post('/inbound-routes', { name: 'to menu', did: '5557001', trunk_id: trunk.id, destination: { type: 'ivr', value: '900' } });
      assert.equal(route.status, 201);
      const second = await post('/ivrs', { number: '901', name: 'Sub menu', options: [{ digit: '9', dest: { type: 'ivr', value: '900' } }] });
      assert.equal(second.status, 201);
      const blocked = await del(`/ivrs/${ivr.id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /inbound route "to menu"/);
      assert.match(blocked.body.error.message, /menu 901 option/);
      // an extension that a menu key rings cannot be deleted
      const ext = (await get('/extensions')).body.extensions.find((e) => e.number === '1002');
      const ext1002 = await del(`/extensions/${ext.id}`);
      assert.equal(ext1002.status, 409);
      assert.match(ext1002.body.error.message, /menu 900 option/);
      await del(`/inbound-routes/${route.body.route.id}`);
      await del(`/ivrs/${second.body.ivr.id}`);
      assert.equal((await del(`/ivrs/${ivr.id}`)).status, 200);
    });

    test('operators cannot manage menus or announcements', async () => {
      assert.equal((await get('/ivrs', operator)).status, 403);
      assert.equal((await post('/ivrs', { number: '910', name: 'X' }, operator)).status, 403);
      assert.equal((await get('/announcements', operator)).status, 403);
    });
  });

  describe('rendering and applying', () => {
    const ext = (n) => ({ id: Number(n), number: n, display_name: `E${n}`, secret: 'a'.repeat(14), phone_secret: 'b'.repeat(14), webrtc_enabled: true, phone_enabled: true, allow_outbound: false, outbound_cid: null, enabled: true, dnd: false, fwd_all: null, fwd_busy: null, fwd_noanswer: null, noanswer_secs: 25 });
    const render = (over) => renderDialplan({ extensions: [ext('1001'), ext('1002')], groups: [], trunks: [], inbound: [], outbound: [], ...over });
    const ivr = (over = {}) => ({ id: 1, number: '900', name: 'Main', prompt_id: 7, timeout_secs: 5, max_repeats: 2, options: [{ digit: '1', dest: { type: 'extension', value: '1001' } }, { digit: '#', dest: { type: 'echo', value: '' } }], fail_dest: { type: 'extension', value: '1002' }, allow_extension_dial: false, enabled: true, ...over });

    test('a menu plays its prompt, waits for a key, routes keys, repeats and then falls back', () => {
      const out = render({ ivrs: [ivr()] });
      const c = out.slice(out.indexOf('[dst-ivr-900]'));
      assert.match(c, /Answer\(\)[\s\S]*Set\(IVR_TRIES=0\)[\s\S]*\(menu\),Set\(TIMEOUT\(digit\)=3\)[\s\S]*Set\(TIMEOUT\(response\)=5\)[\s\S]*Background\(\/pbx-media\/prompts\/7\)[\s\S]*WaitExten\(5\)/);
      assert.match(c, /exten => 1,1,NoOp\(Menu 900: key 1\)\n same => n,Goto\(dst-extension-1001,s,1\)/);
      assert.match(c, /exten => #,1,NoOp\(Menu 900: key #\)\n same => n,Goto\(dst-echo-0,s,1\)/);
      assert.match(c, /exten => t,1,Set\(IVR_TRIES=\$\[0\$\{IVR_TRIES\} \+ 1\]\)\n same => n,GotoIf\(\$\[\$\{IVR_TRIES\} >= 2\]\?giveup\)\n same => n,Goto\(s,menu\)/);
      assert.match(c, /\(giveup\),NoOp\(menu gave up\)\n same => n,Goto\(dst-extension-1002,s,1\)/);
      assert.match(c, /exten => i,1,Goto\(t,1\)/);
      assert.match(out, /exten => 900,1,Set\(CDR\(userfield\)=to:\$\{EXTEN\}\)\n same => n,Goto\(dst-ivr-900,s,1\)/, 'dialable internally');
    });

    test('direct extension dialling is opt-in; a menu key is exactly one character', () => {
      assert.ok(!render({ ivrs: [ivr()] }).includes('direct dial'));
      const withDial = render({ ivrs: [ivr({ allow_extension_dial: true, options: [{ digit: '1', dest: { type: 'echo', value: '' } }] })] });
      assert.match(withDial, /Menu 900: direct dial 1001/);
      assert.match(withDial, /Menu 900: direct dial 1002/);
      assert.ok(!/exten => 1001,1,NoOp\(Menu 900: direct dial 1001\)[\s\S]*exten => 1001,1,NoOp\(Menu 900: direct dial 1001\)/.test(withDial));
      // Keys are single characters and extension numbers have 3 to 6 digits, so they can never be the same.
      assert.throws(() => render({ ivrs: [ivr({ options: [{ digit: '1001', dest: { type: 'echo', value: '' } }] })] }), /unsafe menu key/);
    });

    test('no prompt means silence then wait; no fallback means hang up; disabled menus reject', () => {
      const silent = render({ ivrs: [ivr({ prompt_id: null, fail_dest: null })] });
      const c = silent.slice(silent.indexOf('[dst-ivr-900]'));
      assert.ok(!c.slice(0, c.indexOf('exten => 1,1')).includes('Background'));
      assert.match(c, /\(giveup\),NoOp\(menu gave up\)\n same => n,Hangup\(16\)/);
      const off = render({ ivrs: [ivr({ enabled: false })] });
      assert.match(off.slice(off.indexOf('[dst-ivr-900]')), /Hangup\(21\)/);
      assert.ok(!off.includes('exten => 900,1'));
    });

    test('announcements answer, play and continue', () => {
      const out = render({ announcements: [{ id: 4, name: 'Closed', prompt_id: 7, next_dest: { type: 'ivr', value: '900' }, enabled: true }, { id: 5, name: 'Off', prompt_id: 7, next_dest: null, enabled: false }], ivrs: [ivr()] });
      const a = out.slice(out.indexOf('[dst-announcement-4]'), out.indexOf('[dst-announcement-5]'));
      assert.match(a, /Answer\(\)\n same => n,Playback\(\/pbx-media\/prompts\/7\)\n same => n,Goto\(dst-ivr-900,s,1\)/);
      assert.match(out.slice(out.indexOf('[dst-announcement-5]')), /Hangup\(21\)/);
    });

    test('hostile values are refused', () => {
      assert.throws(() => render({ ivrs: [ivr({ options: [{ digit: '1\nHangup()', dest: { type: 'echo', value: '' } }] })] }), /unsafe/);
      assert.throws(() => render({ ivrs: [ivr({ number: '900\nx' })] }), /unsafe/);
      assert.throws(() => render({ ivrs: [ivr({ options: [{ digit: '1', dest: { type: 'extension', value: '1001\nHangup()' } }] })] }), /unsafe/);
    });

    test('menus and announcements are applied by a dialplan reload only', async () => {
      await h.applier.apply('baseline', { force: true });
      h.ami.reset();
      const prompt = await upload('Reload test', makeWav({ seconds: 1 }));
      assert.equal(prompt.status, 201);
      assert.equal((await post('/announcements', { name: 'Reload ann', prompt_id: prompt.body.prompt.id })).status, 201);
      await new Promise((r) => setTimeout(r, 600));
      assert.deepEqual(h.ami.callsFor('Command').map((c) => c.Command), ['dialplan reload']);
      const files = fs.readFileSync(`${h.generatedDir}/extensions_generated.conf`, 'utf8');
      assert.match(files, new RegExp(`Playback\\(/pbx-media/prompts/${prompt.body.prompt.id}\\)`));
    });
  });
});
