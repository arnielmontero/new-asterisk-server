'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, auditCount } = require('./helpers');
const { renderDialplan } = require('../src/pbx/render');
const { wavInfo } = require('../src/media/wavinfo');

// What Asterisk's Record() / MixMonitor write: 8 kHz, 16-bit mono PCM.
function wav(secs, { headerOnly = false } = {}) {
  const data = headerOnly ? Buffer.alloc(0) : Buffer.alloc(Math.round(secs * 16000));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const ext = (number, over = {}) => ({ id: Number(number), number, display_name: `E${number}`, secret: 'a'.repeat(14), phone_secret: 'b'.repeat(14), webrtc_enabled: true, phone_enabled: true, allow_outbound: false, outbound_cid: null, enabled: true, dnd: false, fwd_all: null, fwd_busy: null, fwd_noanswer: null, noanswer_secs: 25, voicemail_enabled: false, voicemail_greeting_id: null, voicemail_max_secs: 120, record_calls: false, ...over });
const trunk = (over = {}) => ({ id: 1, name: 'acme', display_name: 'Acme', enabled: true, auth_mode: 'ip', host: '10.0.0.9', port: 5060, transport: 'udp', codecs: ['ulaw'], dtmf_mode: 'rfc4733', max_channels: 0, qualify: true, match_ips: [], inbound_default: { type: 'extension', value: '1001' }, record_calls: false, ...over });
const render = (over = {}) => renderDialplan({ extensions: [ext('1001'), ext('1002')], groups: [], trunks: [], inbound: [], outbound: [], ...over });

describe('voicemail and recording: dialplan', () => {
  test('a voicemail box is a destination that greets, beeps, records and reports the file', () => {
    const out = render({ extensions: [ext('1001', { voicemail_enabled: true, voicemail_greeting_id: 7, voicemail_max_secs: 90 }), ext('1002')] });
    const c = out.slice(out.indexOf('[dst-voicemail-1001]'), out.indexOf('[dst-voicemail-1002]'));
    assert.match(c, /Gosub\(sub-hop,s,1\)\n same => n,Answer\(\)\n same => n,Wait\(1\)\n same => n,Set\(VM_FILE=1001-\$\{UNIQUEID\}\.wav\)/);
    assert.match(c, /Set\(VM_CALLER=\$\{FILTER\(0-9A-Za-z\+\*#\._@,\$\{CALLERID\(num\)\}\)\}\)/, 'the caller id is filtered before it reaches the event');
    assert.ok(c.indexOf('Playback(/pbx-media/prompts/7)') < c.indexOf('Playtones('), 'greeting, then beep');
    assert.match(c, /Record\(\/pbx-media\/voicemail\/\$\{VM_FILE\},4,90,kq\)/, 'keeps the file when the caller hangs up, no sound file for a beep');
    assert.match(c, /UserEvent\(VoicemailLeft,Extension: 1001,File: \$\{VM_FILE\},Caller: \$\{VM_CALLER\}\)\n same => n,Hangup\(\)/);
    assert.match(c, /exten => h,1,ExecIf\(\$\["\$\{VM_STARTED\}" = "1" & "\$\{VM_DONE\}" != "1"\]\?UserEvent\(VoicemailLeft/, 'a caller who hangs up is reported once');
    assert.match(out.slice(out.indexOf('[dst-voicemail-1002]')), /^\[dst-voicemail-1002\]\nexten => s,1,NoOp\(dst-voicemail-1002\)\n same => n,Gosub\(sub-hop,s,1\)\n same => n,Hangup\(21\)/, 'no voicemail: reject');
  });

  test('without a greeting the caller hears just the beep; a disabled extension has no box', () => {
    const out = render({ extensions: [ext('1001', { voicemail_enabled: true }), ext('1002', { voicemail_enabled: true, enabled: false })] });
    const c = out.slice(out.indexOf('[dst-voicemail-1001]'), out.indexOf('[dst-voicemail-1002]'));
    assert.ok(!c.includes('Playback('));
    assert.match(c, /Record\([^)]*,120,kq\)/);
    assert.match(out.slice(out.indexOf('[dst-voicemail-1002]')), /Hangup\(21\)/);
  });

  test('settings carry whether voicemail is on; recording extensions and trunks are listed for the dialplan', () => {
    const out = render({
      extensions: [ext('1001', { voicemail_enabled: true, record_calls: true }), ext('1002'), ext('1003', { record_calls: true, enabled: false })],
      trunks: [trunk({ record_calls: true })],
    });
    const settings = out.slice(out.indexOf('[ext-settings]'), out.indexOf('[ext-record]'));
    assert.match(settings, /exten => 1001,1,[\s\S]*Set\(X_NA_SECS=25\)\n same => n,Set\(X_VM=1\)\n same => n,Return\(\)/);
    assert.match(settings, /exten => 1002,1,[\s\S]*Set\(X_VM=0\)/);
    const rec = out.slice(out.indexOf('[ext-record]'), out.indexOf('[trunk-meta]'));
    assert.match(rec, /exten => 1001,1,Return\(\)/);
    assert.ok(!rec.includes('1002') && !rec.includes('1003'), 'only enabled extensions with recording on');
    assert.match(out, /exten => trk-acme,1,[\s\S]*Set\(TRUNK_REC=1\)/);
  });

  test('a recording trunk starts recording before the call is routed, for matched and unmatched numbers', () => {
    const inbound = [{ id: 4, name: 'main', did: '5551000', trunk_id: null, trunk_name: null, destination: { type: 'extension', value: '1001' }, cid_name_prefix: null, enabled: true }];
    const on = render({ trunks: [trunk({ record_calls: true })], inbound });
    const block = on.slice(on.indexOf('[from-trunk-acme]'), on.indexOf('[dst-echo-0]'));
    assert.match(block, /exten => 5551000,1,NoOp\(Inbound acme -> route 4\)\n same => n,Set\(CDR\(userfield\)=in:\$\{EXTEN\}\)\n same => n,Gosub\(sub-rec-start,s,1\)\n same => n,Goto\(dst-extension-1001,s,1\)/);
    assert.match(block, /exten => _X\.,1,[\s\S]*unrouted\)\n same => n,Gosub\(sub-rec-start,s,1\)/);
    const off = render({ trunks: [trunk()], inbound });
    assert.ok(!off.includes('Gosub(sub-rec-start'), 'nothing is recorded unless switched on');
  });

  test('the voicemail destination is accepted wherever a destination is', () => {
    const out = render({ extensions: [ext('1001', { voicemail_enabled: true, fwd_noanswer: { type: 'voicemail', value: '1001' } }), ext('1002')] });
    assert.match(out, /Set\(X_FWD_NA=dst-voicemail-1001\)/);
  });

  test('hostile values are refused', () => {
    assert.throws(() => render({ extensions: [ext('1001\nexten => x', { voicemail_enabled: true })] }), /unsafe/);
  });
});

describe('voicemail and recording: configuration through the API', () => {
  let h; let admin; let operator; let other;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.vm', role: 'operator', extension: '1001' });
    other = await h.makeUser({ username: 'op.vm2', role: 'operator', extension: '1002' });
  });
  after(async () => h.cleanup());

  const post = (url, body, who = admin) => h.agent().post(`/api/pbx${url}`).set(who.auth).send(body);
  const patch = (url, body, who = admin) => h.agent().patch(`/api/pbx${url}`).set(who.auth).send(body);
  const get = (url, who = admin) => h.agent().get(`/api/pbx${url}`).set(who.auth);
  const del = (url, who = admin) => h.agent().delete(`/api/pbx${url}`).set(who.auth);
  const ext = async (n) => (await get('/extensions')).body.extensions.find((e) => e.number === n);

  test('extensions start with voicemail and recording off and take the settings', async () => {
    const e = await ext('1001');
    assert.equal(e.voicemail_enabled, false);
    assert.equal(e.record_calls, false);
    assert.equal(e.voicemail_max_secs, 120);
    const res = await patch(`/extensions/${e.id}`, { voicemail_enabled: true, voicemail_max_secs: 45, record_calls: true });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.extension.voicemail_enabled, res.body.extension.voicemail_max_secs, res.body.extension.record_calls], [true, 45, true]);
    for (const bad of [{ voicemail_max_secs: 5 }, { voicemail_max_secs: 601 }, { voicemail_enabled: 'yes' }, { record_calls: 1 }, { voicemail_greeting_id: 0 }]) {
      assert.equal((await patch(`/extensions/${e.id}`, bad)).status, 400, JSON.stringify(bad));
    }
    const created = await post('/extensions', { number: '1010', display_name: 'New', voicemail_enabled: true, record_calls: true });
    assert.equal(created.status, 201);
    assert.equal(created.body.extension.voicemail_enabled, true);
  });

  test('the dialplan changes only when the settings do, and an apply writes the voicemail context', async () => {
    await new Promise((r) => setTimeout(r, 600));
    await h.applier.apply('baseline', { force: true });
    const file = fs.readFileSync(path.join(h.generatedDir, 'extensions_generated.conf'), 'utf8');
    assert.match(file, /\[dst-voicemail-1001\][\s\S]*Record\([^)]*,45,kq\)/);
    assert.match(file, /\[ext-record\]\nexten => 1001,1,Return\(\)/);
  });

  test('a greeting must be a prompt that exists, and a prompt used as a greeting cannot be deleted', async () => {
    const e = await ext('1001');
    assert.equal((await patch(`/extensions/${e.id}`, { voicemail_greeting_id: 4242 })).status, 400);
    const up = await h.agent().post('/api/pbx/prompts?name=Greeting').set(admin.auth).set('Content-Type', 'audio/wav').send(wav(1.5));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const promptId = up.body.prompt.id;
    const set = await patch(`/extensions/${e.id}`, { voicemail_greeting_id: promptId });
    assert.equal(set.status, 200);
    assert.equal(set.body.extension.voicemail_greeting_id, promptId);
    const blocked = await del(`/prompts/${promptId}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /voicemail greeting of extension 1001/);
    assert.equal((await get('/prompts')).body.prompts.find((p) => p.id === promptId).in_use, true);
    assert.equal((await patch(`/extensions/${e.id}`, { voicemail_greeting_id: null })).status, 200);
    assert.equal((await del(`/prompts/${promptId}`)).status, 200);
  });

  test('a voicemail box is a destination only while voicemail is on, and it cannot be switched off while in use', async () => {
    const e1002 = await ext('1002');
    assert.equal((await patch(`/extensions/${e1002.id}`, { fwd_noanswer: { type: 'voicemail', value: '1001' } })).status, 200, 'box 1001 has voicemail');
    assert.equal((await patch(`/extensions/${e1002.id}`, { fwd_noanswer: { type: 'voicemail', value: '1002' } })).status, 400, 'box 1002 has none');
    assert.equal((await patch(`/extensions/${e1002.id}`, { fwd_noanswer: { type: 'voicemail', value: '12' } })).status, 400);
    const e1001 = await ext('1001');
    const blocked = await patch(`/extensions/${e1001.id}`, { voicemail_enabled: false });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /extension 1002 forwarding/);
    assert.equal((await del(`/extensions/${e1001.id}`)).status, 409, 'deleting the extension is also refused');
    await patch(`/extensions/${e1002.id}`, { fwd_noanswer: null });
    assert.equal((await patch(`/extensions/${e1001.id}`, { voicemail_enabled: false })).status, 200);
    assert.equal((await patch(`/extensions/${e1001.id}`, { voicemail_enabled: true })).status, 200);
  });

  test('trunks take a recording switch, off by default', async () => {
    const made = await post('/trunks', { name: 'rec1', display_name: 'R', auth_mode: 'ip', host: '10.2.2.2' });
    assert.equal(made.status, 201);
    assert.equal(made.body.trunk.record_calls, false);
    const upd = await patch(`/trunks/${made.body.trunk.id}`, { record_calls: true });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.trunk.record_calls, true);
    assert.equal((await patch(`/trunks/${made.body.trunk.id}`, { record_calls: 'on' })).status, 400);
  });

  test('people switch their own voicemail on and off; nothing else of their extension', async () => {
    const mine = await h.agent().get('/api/my/extension').set(operator.auth);
    assert.equal(mine.body.extension.voicemail_enabled, true);
    const off = await h.agent().patch('/api/my/extension').set(operator.auth).send({ voicemail_enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.extension.voicemail_enabled, false);
    assert.equal((await h.agent().patch('/api/my/extension').set(operator.auth).send({ record_calls: false })).status, 400, 'recording is an administrator decision');
    await h.agent().patch('/api/my/extension').set(operator.auth).send({ voicemail_enabled: true });
  });
});

describe('voicemail messages', () => {
  let h; let admin; let alice; let bob; let reader;
  const media = () => path.join(h.mediaDir, 'voicemail');
  const leave = async (extension, file, { secs = 3, caller = '5551234', raw = null } = {}) => {
    if (raw !== false) fs.writeFileSync(path.join(media(), file), raw || wav(secs));
    return h.voicemail.ingest({ Event: 'UserEvent', UserEvent: 'VoicemailLeft', Extension: extension, File: file, Caller: caller });
  };
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    alice = await h.makeUser({ username: 'alice.vm', role: 'operator', extension: '1001' });
    bob = await h.makeUser({ username: 'bob.vm', role: 'operator', extension: '1002' });
    reader = await h.makeUser({ username: 'read.vm', role: 'user' });
    await h.db.query("UPDATE extensions SET voicemail_enabled = TRUE WHERE number IN ('1001','1002')");
  });
  after(async () => h.cleanup());

  const list = (who, q = '') => h.agent().get(`/api/voicemail${q}`).set(who.auth);

  test('wavInfo reads the length from the real size, and rejects what is not a WAV', async () => {
    const f = path.join(h.mediaDir, 'x.wav');
    fs.writeFileSync(f, wav(2.5));
    assert.deepEqual(await wavInfo(f), { bytes: 44 + 40000, durationSecs: 2.5 });
    const stillWriting = wav(4); stillWriting.writeUInt32LE(0, 40); // header not finalised yet
    fs.writeFileSync(f, stillWriting);
    assert.equal((await wavInfo(f)).durationSecs, 4);
    fs.writeFileSync(f, Buffer.from('not a wav file at all, but long enough to have a header...............'));
    assert.equal(await wavInfo(f), null);
    assert.equal(await wavInfo(path.join(h.mediaDir, 'missing.wav')), null);
  });

  test('a reported message is stored with its caller and length; the owner gets a live notification', async () => {
    const seen = [];
    h.voicemail.onChange = (m) => seen.push(m);
    const id = await leave('1001', '1001-1700000000.1.wav', { secs: 3.4 });
    assert.ok(id);
    const res = await list(alice);
    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 1);
    assert.deepEqual([res.body.messages[0].extension, res.body.messages[0].caller, res.body.messages[0].duration_secs, res.body.messages[0].heard], ['1001', '5551234', 3, false]);
    assert.deepEqual(res.body.unread, { 1001: 1 });
    assert.deepEqual(seen, [{ extension: '1001', kind: 'new', id }]);
    assert.equal(await leave('1001', '1001-1700000000.1.wav'), null, 'reporting the same file twice does not duplicate it');
    assert.equal((await list(alice)).body.messages.length, 1);
  });

  test('the AMI event path stores it too', async () => {
    fs.writeFileSync(path.join(media(), '1002-1700000001.2.wav'), wav(2));
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'VoicemailLeft', Extension: '1002', File: '1002-1700000001.2.wav', Caller: '1001' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await list(bob)).body.messages.length, 1);
  });

  test('forged, stale or empty reports create nothing', async () => {
    const before = (await list(admin)).body.messages.length;
    assert.equal(await leave('1001', '1002-1700000002.1.wav'), null, 'file belongs to another box');
    assert.equal(await leave('1001', '1001-nothing-here.wav', { raw: false }), null, 'no such file');
    assert.equal(await leave('1001', '../../etc/passwd.wav', { raw: false }), null, 'path traversal');
    assert.equal(await leave('1001', '1001-1700000003.1.mp3', { raw: false }), null, 'not a wav name');
    assert.equal(await leave('9999', '9999-1700000003.1.wav'), null, 'unknown extension');
    assert.equal(await leave('1001', '1001-1700000004.1.wav', { raw: Buffer.from('definitely not audio, just text pretending to be a recording') }), null, 'not audio');
    assert.equal(await leave('1001', '1001-1700000005.1.wav', { secs: 0.3 }), null, 'a hang-up during the greeting is not a message');
    assert.ok(!fs.existsSync(path.join(media(), '1001-1700000005.1.wav')), 'and its file is removed');
    assert.equal(await leave('1001', '1001-1700000006.1.wav', { caller: 'x,File: y' }) > 0, true, 'a hostile caller id is stored as unknown, not trusted');
    assert.equal((await list(admin)).body.messages.find((m) => m.extension === '1001' && m.caller === null).duration_secs, 3);
    assert.equal((await list(admin)).body.messages.length, before + 1);
  });

  test('people see only their own box; administrators see all; others are refused', async () => {
    assert.ok((await list(alice)).body.messages.every((m) => m.extension === '1001'));
    assert.ok((await list(bob)).body.messages.every((m) => m.extension === '1002'));
    const all = await list(admin);
    assert.deepEqual([...new Set(all.body.messages.map((m) => m.extension))].sort(), ['1001', '1002']);
    assert.equal((await list(admin, '?extension=1002')).body.messages.every((m) => m.extension === '1002'), true);
    assert.equal((await list(reader)).status, 403, 'a read-only user has no box');
    assert.equal((await h.agent().get('/api/voicemail')).status, 401);
    assert.equal((await list(alice, '?extension=abc')).status, 400);
    // an operator cannot ask for somebody else's box
    assert.ok((await list(alice, '?extension=1002')).body.messages.every((m) => m.extension === '1001'));
  });

  test('audio is served to the owner and administrators only, and listening is audited', async () => {
    const mine = (await list(alice)).body.messages[0];
    const theirs = (await list(bob)).body.messages[0];
    const audited = await auditCount(h.db, "action = 'voicemail.play'");
    const ok = await h.agent().get(`/api/voicemail/${mine.id}/audio`).set(alice.auth).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /audio\/wav/);
    assert.equal(ok.body.toString('ascii', 0, 4), 'RIFF');
    assert.equal((await h.agent().get(`/api/voicemail/${theirs.id}/audio`).set(alice.auth)).status, 403);
    assert.equal((await h.agent().get(`/api/voicemail/${theirs.id}/audio`).set(admin.auth)).status, 200);
    assert.equal((await h.agent().get(`/api/voicemail/${mine.id}/audio`).set(reader.auth)).status, 403);
    assert.equal((await h.agent().get('/api/voicemail/99999/audio').set(admin.auth)).status, 404);
    assert.equal(await auditCount(h.db, "action = 'voicemail.play'"), audited + 2);
  });

  test('messages are marked heard or new, and the unread count follows', async () => {
    const m = (await list(alice)).body.messages[0];
    const seen = [];
    h.voicemail.onChange = (x) => seen.push(x);
    const heard = await h.agent().patch(`/api/voicemail/${m.id}`).set(alice.auth).send({ heard: true });
    assert.equal(heard.status, 200);
    assert.equal(heard.body.message.heard, true);
    assert.equal((await list(alice)).body.unread['1001'], (await list(alice)).body.messages.filter((x) => !x.heard).length);
    assert.deepEqual(seen, [{ extension: '1001', kind: 'heard', id: m.id }]);
    assert.equal((await h.agent().patch(`/api/voicemail/${m.id}`).set(alice.auth).send({ heard: false })).body.message.heard, false);
    assert.equal((await h.agent().patch(`/api/voicemail/${m.id}`).set(bob.auth).send({ heard: true })).status, 403);
    assert.equal((await h.agent().patch(`/api/voicemail/${m.id}`).set(alice.auth).send({ heard: 'yes' })).status, 400);
    assert.equal((await h.agent().patch(`/api/voicemail/${m.id}`).set(alice.auth).send({})).status, 400);
  });

  test('deleting removes the message and its audio file; others cannot delete it', async () => {
    const m = (await list(alice)).body.messages[0];
    const file = (await h.voicemail.get(m.id)).file;
    assert.ok(fs.existsSync(path.join(media(), file)));
    assert.equal((await h.agent().delete(`/api/voicemail/${m.id}`).set(bob.auth)).status, 403);
    assert.ok(fs.existsSync(path.join(media(), file)));
    assert.equal((await h.agent().delete(`/api/voicemail/${m.id}`).set(alice.auth)).status, 200);
    assert.ok(!fs.existsSync(path.join(media(), file)));
    assert.equal((await h.agent().delete(`/api/voicemail/${m.id}`).set(alice.auth)).status, 404);
    assert.ok(await auditCount(h.db, "action = 'voicemail.delete'") >= 1);
  });

  test('retention removes old messages and their files; deleting an extension removes its box', async () => {
    const id = await leave('1002', '1002-1700000009.1.wav');
    await h.db.query(`UPDATE voicemails SET created_at = now() - interval '40 days' WHERE id = $1`, [id]);
    assert.equal(await h.voicemail.prune(30), 1);
    assert.ok(!fs.existsSync(path.join(media(), '1002-1700000009.1.wav')));
    await leave('1002', '1002-1700000010.1.wav');
    const e = (await h.store.listExtensions()).find((x) => x.number === '1002');
    await h.db.query('DELETE FROM users WHERE extension = $1', ['1002']);
    await h.store.deleteExtension(e.id);
    assert.equal(Number((await h.db.query("SELECT count(*) AS n FROM voicemails WHERE extension = '1002'")).rows[0].n), 0);
    assert.ok(!fs.existsSync(path.join(media(), '1002-1700000010.1.wav')));
  });
});

describe('call recordings', () => {
  let h; let admin; let operator;
  const dir = () => path.join(h.mediaDir, 'recordings');
  const start = (uid, linked = uid) => h.recordings.started({ Event: 'UserEvent', UserEvent: 'RecordingStarted', File: `${uid}.wav`, Uniqueid: uid, Linkedid: linked });
  const stop = (uid) => h.recordings.finish(uid);
  const cdrRow = (uid, linked, src, dst, billsec = 5) => h.db.query(
    `INSERT INTO cdr (unique_id, linked_id, start_time, src, dst, disposition, duration, billsec, direction, channel)
     VALUES ($1,$2,now(),$3,$4,'ANSWERED',$5,$5,'internal','PJSIP/x-1')`, [uid, linked, src, dst, billsec]);
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.rec', role: 'operator', extension: '1001' });
    h.recordings.settleMs = 0;
    h.recordings.endDelayMs = 50;
  });
  after(async () => h.cleanup());

  const list = (who, q = '') => h.agent().get(`/api/recordings${q}`).set(who.auth);

  test('a recording is listed once it has ended, with who talked to whom from the call history', async () => {
    const id = await start('1700000100.5', '1700000100.4');
    assert.ok(id);
    assert.equal((await list(admin)).body.total, 0, 'not listed while the call is still being recorded');
    fs.writeFileSync(path.join(dir(), '1700000100.5.wav'), wav(7));
    await cdrRow('1700000100.4', '1700000100.4', '1001', '1002', 7);
    assert.equal(await stop('1700000100.5'), id);
    const res = await list(admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.deepEqual([res.body.items[0].src, res.body.items[0].dst, res.body.items[0].duration_secs, res.body.items[0].direction], ['1001', '1002', 7, 'internal']);
    assert.equal(res.body.items[0].size_bytes, 44 + 7 * 16000);
    assert.equal(res.body.items[0].file, undefined, 'the file name is not exposed');
  });

  test('the hang-up of the recording channel ends a recording (and only that channel, only once)', async () => {
    await start('1700000101.1');
    fs.writeFileSync(path.join(dir(), '1700000101.1.wav'), wav(3));
    h.ami.emit('event', { Event: 'Hangup', Uniqueid: '1700000101.99', Channel: 'PJSIP/other-00000001' });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((await list(admin)).body.total, 1, 'another channel hanging up changes nothing');
    h.ami.emit('event', { Event: 'Hangup', Uniqueid: '1700000101.1', Channel: 'PJSIP/1001-00000001' });
    h.ami.emit('event', { Event: 'Hangup', Uniqueid: '1700000101.1', Channel: 'PJSIP/1001-00000001' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await list(admin)).body.total, 2);
  });

  test('a file that is still growing is measured when it stops', async () => {
    await start('1700000105.1');
    const f = path.join(dir(), '1700000105.1.wav');
    fs.writeFileSync(f, wav(2));
    h.recordings.settleMs = 120;
    const grow = setTimeout(() => fs.writeFileSync(f, wav(6)), 60);
    assert.ok(await stop('1700000105.1'));
    clearTimeout(grow);
    h.recordings.settleMs = 0;
    assert.equal((await list(admin)).body.items.find((i) => i.size_bytes === 44 + 6 * 16000).duration_secs, 6);
    assert.equal((await h.recordings.remove((await list(admin)).body.items.find((i) => i.size_bytes === 44 + 6 * 16000).id)).duration_secs, 6);
  });

  test('a call that never got to talking leaves no recording; forged reports are refused', async () => {
    await start('1700000102.1');
    fs.writeFileSync(path.join(dir(), '1700000102.1.wav'), wav(0, { headerOnly: true }));
    assert.equal(await stop('1700000102.1'), null);
    assert.ok(!fs.existsSync(path.join(dir(), '1700000102.1.wav')));
    await start('1700000103.1');
    assert.equal(await stop('1700000103.1'), null, 'file never appeared');
    assert.equal(await stop('1700000999.9'), null, 'unknown call');
    for (const evt of [
      { File: '../x.wav', Uniqueid: '../x' },
      { File: 'a.wav', Uniqueid: 'b' },
      { File: '1700000104.1.mp3', Uniqueid: '1700000104.1' },
      { File: '1700;000104.1.wav', Uniqueid: '1700;000104.1' },
      { File: '.wav', Uniqueid: '' },
    ]) assert.equal(await h.recordings.started({ Event: 'UserEvent', UserEvent: 'RecordingStarted', Linkedid: 'x', ...evt }), null, JSON.stringify(evt));
    assert.equal((await list(admin)).body.total, 2);
  });

  test('only administrators list, listen to or delete recordings; listening and deleting are audited', async () => {
    assert.equal((await list(operator)).status, 403);
    assert.equal((await h.agent().get('/api/recordings')).status, 401);
    const first = (await list(admin)).body.items.find((i) => i.src === '1001');
    assert.equal((await h.agent().get(`/api/recordings/${first.id}/audio`).set(operator.auth)).status, 403);
    const plays = await auditCount(h.db, "action = 'recording.play'");
    const ok = await h.agent().get(`/api/recordings/${first.id}/audio`).set(admin.auth).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.length, 44 + 7 * 16000);
    const ranged = await h.agent().get(`/api/recordings/${first.id}/audio`).set(admin.auth).set('Range', 'bytes=1000-1999');
    assert.equal(ranged.status, 206, 'players can seek');
    assert.equal(await auditCount(h.db, "action = 'recording.play'"), plays + 1, 'a seek inside the same listen is not a second listen');
    assert.equal((await h.agent().get('/api/recordings/99999/audio').set(admin.auth)).status, 404);
    assert.equal((await h.agent().get('/api/recordings/abc/audio').set(admin.auth)).status, 400);
  });

  test('filters: period and number; paging', async () => {
    assert.equal((await list(admin, '?number=1002')).body.total, 1);
    assert.equal((await list(admin, '?number=555')).body.total, 0);
    assert.equal((await list(admin, `?from=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}`)).body.total, 0);
    assert.equal((await list(admin, '?pageSize=1&page=2')).body.items.length, 1);
    assert.equal((await list(admin, '?pageSize=1000')).status, 400);
    assert.equal((await list(admin, '?number=a;b')).status, 400);
  });

  test('call history points at the recording of a call', async () => {
    const rows = await h.cdr.list({ page: 1, pageSize: 50, legs: 'calls' });
    const call = rows.items.find((r) => r.unique_id === '1700000100.4');
    assert.ok(call.recording_id > 0);
    await cdrRow('1700000500.1', '1700000500.1', '1001', '1002');
    assert.equal((await h.cdr.list({ page: 1, pageSize: 50, legs: 'calls' })).items.find((r) => r.unique_id === '1700000500.1').recording_id, null);
  });

  test('delete removes the file; retention removes old ones; a lost end is recovered from the file', async () => {
    const first = (await list(admin)).body.items.find((i) => i.src === '1001');
    assert.equal((await h.agent().delete(`/api/recordings/${first.id}`).set(admin.auth)).status, 200);
    assert.ok(!fs.existsSync(path.join(dir(), '1700000100.5.wav')));
    assert.equal((await h.agent().delete(`/api/recordings/${first.id}`).set(admin.auth)).status, 404);
    assert.ok(await auditCount(h.db, "action = 'recording.delete'") >= 1);

    await h.db.query("UPDATE recordings SET started_at = now() - interval '100 days' WHERE unique_id = '1700000101.1'");
    assert.equal(await h.recordings.prune(30), 1);
    assert.ok(!fs.existsSync(path.join(dir(), '1700000101.1.wav')));

    await start('1700000200.1');
    fs.writeFileSync(path.join(dir(), '1700000200.1.wav'), wav(5));
    assert.equal(await h.recordings.sweep(180), 0, 'recent recordings may still be running');
    await h.db.query("UPDATE recordings SET started_at = now() - interval '5 hours' WHERE unique_id = '1700000200.1'");
    assert.equal(await h.recordings.sweep(180), 1);
    assert.equal((await list(admin)).body.items[0].duration_secs, 5);
  });
});
