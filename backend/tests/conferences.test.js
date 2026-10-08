'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, auditCount } = require('./helpers');
const { renderDialplan } = require('../src/pbx/render');

const ext = (number) => ({ id: Number(number), number, display_name: `E${number}`, secret: 'a'.repeat(14), phone_secret: 'b'.repeat(14), webrtc_enabled: true, phone_enabled: true, allow_outbound: false, outbound_cid: null, enabled: true, dnd: false, fwd_all: null, fwd_busy: null, fwd_noanswer: null, noanswer_secs: 25 });
const room = (over = {}) => ({ id: 1, number: '900', name: 'Team', pin: null, admin_pin: null, mute_on_join: false, max_members: 0, enabled: true, ...over });
const render = (conferences) => renderDialplan({ extensions: [ext('1001')], groups: [], trunks: [], inbound: [], outbound: [], conferences });
const block = (out, n) => out.slice(out.indexOf(`[dst-conference-${n}]`), out.indexOf('\n\n', out.indexOf(`[dst-conference-${n}]`)));

describe('conference rooms: dialplan', () => {
  test('an open room answers and joins with the static profiles', () => {
    const out = render([room()]);
    const c = block(out, '900');
    assert.match(c, /Gosub\(sub-hop,s,1\)\n same => n,Answer\(\)\n same => n,Set\(CONFBRIDGE\(bridge,template\)=c-bridge\)\n same => n,Set\(CONFBRIDGE\(user,template\)=c-user\)\n same => n,Set\(CONFBRIDGE\(menu,template\)=c-menu\)\n same => n\(join\),ConfBridge\(900\)\n same => n,Hangup\(\)/);
    assert.ok(!c.includes('Read('), 'no PIN prompt');
    assert.match(out, /exten => 900,1,Set\(CDR\(userfield\)=to:\$\{EXTEN\}\)\n same => n,Goto\(dst-conference-900,s,1\)/, 'dialable by number');
  });

  test('a PIN is read after a tone, compared in the dialplan, retried three times, then refused', () => {
    const c = block(render([room({ pin: '4321' })]), '900');
    assert.match(c, /Set\(CF_TRIES=0\)\n same => n\(ask\),Set\(CF_TRIES=\$\[\$\{CF_TRIES\} \+ 1\]\)\n same => n,Playtones\(!800\/250\)/);
    assert.match(c, /Read\(CF_PIN,,10,,1,10\)\n same => n,GotoIf\(\$\["\$\{CF_PIN\}" = "4321"\]\?join\)/);
    assert.match(c, /Playtones\(congestion\)[\s\S]*GotoIf\(\$\[\$\{CF_TRIES\} < 3\]\?ask\)\n same => n,Hangup\(21\)/);
    assert.ok(!c.includes('(admin)'), 'no administrator without an administrator PIN');
  });

  test('the administrator PIN joins with administrator rights; a room with only that PIN stays open to others', () => {
    const both = block(render([room({ pin: '1111', admin_pin: '9999' })]), '900');
    assert.match(both, /= "9999"\]\?admin\)\n same => n,GotoIf\(\$\["\$\{CF_PIN\}" = "1111"\]\?join\)/);
    assert.match(both, /\(admin\),Set\(CONFBRIDGE\(user,admin\)=yes\)\n same => n\(join\),ConfBridge\(900\)/);
    const only = block(render([room({ admin_pin: '9999' })]), '900');
    assert.match(only, /= "9999"\]\?admin\)\n same => n,GotoIf\(\$\["\$\{CF_PIN\}" = ""\]\?join\)/, 'pressing nothing joins as a normal participant');
  });

  test('muting on entry and the member limit are applied before joining', () => {
    const c = block(render([room({ mute_on_join: true, max_members: 12 })]), '900');
    assert.match(c, /Set\(CONFBRIDGE\(bridge,max_members\)=12\)\n same => n,Set\(CONFBRIDGE\(user,startmuted\)=yes\)\n same => n\(join\)/);
  });

  test('a disabled room rejects and cannot be dialled; hostile values are refused', () => {
    const out = render([room({ enabled: false })]);
    assert.match(block(out, '900'), /Hangup\(21\)/);
    assert.ok(!out.includes('exten => 900,1'));
    for (const bad of [{ pin: '12";Hangup()' }, { admin_pin: '1234\nexten => x' }, { number: '900\n[evil]' }, { pin: '12' }]) {
      assert.throws(() => render([room(bad)]), /unsafe/, JSON.stringify(bad));
    }
  });
});

describe('conference rooms: API', () => {
  let h; let admin; let operator;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.conf', role: 'operator', extension: '1001' });
  });
  after(async () => h.cleanup());

  const post = (url, body, who = admin) => h.agent().post(`/api/pbx${url}`).set(who.auth).send(body);
  const patch = (url, body, who = admin) => h.agent().patch(`/api/pbx${url}`).set(who.auth).send(body);
  const get = (url, who = admin) => h.agent().get(`/api/pbx${url}`).set(who.auth);
  const del = (url, who = admin) => h.agent().delete(`/api/pbx${url}`).set(who.auth);

  test('create, read back, update; the room number is shared with every other kind of number', async () => {
    const res = await post('/conferences', { number: '900', name: 'Team', pin: '4321', admin_pin: '9876', max_members: 8 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.conference.pin, res.body.conference.admin_pin, res.body.conference.max_members, res.body.conference.mute_on_join, res.body.conference.enabled], ['4321', '9876', 8, false, true]);
    const upd = await patch(`/conferences/${res.body.conference.id}`, { mute_on_join: true, pin: null, name: 'All hands' });
    assert.equal(upd.status, 200);
    assert.deepEqual([upd.body.conference.pin, upd.body.conference.mute_on_join, upd.body.conference.name], [null, true, 'All hands']);
    for (const number of ['900', '1001', '700', '600']) assert.equal((await post('/conferences', { number, name: 'Clash' })).status, 409, number);
    assert.equal((await post('/extensions', { number: '900', display_name: 'Clash' })).status, 409, 'an extension cannot take a room number');
    assert.equal((await post('/queues', { number: '900', name: 'Clash', members: ['1001'] })).status, 409);
    assert.equal((await post('/ring-groups', { number: '900', name: 'Clash', members: ['1001'] })).status, 409);
    assert.equal((await post('/ivrs', { number: '900', name: 'Clash' })).status, 409);
  });

  test('validation: numbers, PINs, limits and unknown fields', async () => {
    for (const bad of [
      { number: '12', name: 'x' }, { number: '901', name: '' }, { number: '901', name: 'x;y' },
      { number: '901', name: 'x', pin: '12' }, { number: '901', name: 'x', pin: 'abcd' }, { number: '901', name: 'x', pin: '12345678901' },
      { number: '901', name: 'x', pin: '1234', admin_pin: '1234' }, { number: '901', name: 'x', max_members: 1 }, { number: '901', name: 'x', max_members: 201 },
      { number: '901', name: 'x', extra: true },
    ]) assert.equal((await post('/conferences', bad)).status, 400, JSON.stringify(bad));
    const id = (await get('/conferences')).body.conferences[0].id;
    for (const bad of [{}, { pin: '99' }, { max_members: 1 }, { number: '555' }]) assert.equal((await patch(`/conferences/${id}`, bad)).status, 400, JSON.stringify(bad));
    const withAdmin = await patch(`/conferences/${id}`, { pin: '9876' });
    assert.equal(withAdmin.status, 400, 'the new room PIN may not equal the stored administrator PIN');
  });

  test('a room is a destination; one that is used cannot be deleted', async () => {
    const room = (await get('/conferences')).body.conferences[0];
    await post('/trunks', { name: 'cft', display_name: 'T', auth_mode: 'ip', host: '10.8.8.8' });
    const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'cft');
    assert.equal((await post('/inbound-routes', { name: 'bad', did: '5559000', trunk_id: trunk.id, destination: { type: 'conference', value: '905' } })).status, 400, 'unknown room');
    const route = await post('/inbound-routes', { name: 'to room', did: '5559001', trunk_id: trunk.id, destination: { type: 'conference', value: room.number } });
    assert.equal(route.status, 201);
    const blocked = await del(`/conferences/${room.id}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /inbound route "to room"/);
    await del(`/inbound-routes/${route.body.route.id}`);
    assert.equal((await del(`/conferences/${room.id}`)).status, 200);
    assert.equal((await del(`/conferences/${room.id}`)).status, 404);
  });

  test('applying writes the room into the dialplan; only administrators manage rooms; PINs are not audited', async () => {
    const made = await post('/conferences', { number: '910', name: 'Board', pin: '5550123' });
    assert.equal(made.status, 201);
    await new Promise((r) => setTimeout(r, 600));
    await h.applier.apply('baseline', { force: true });
    const file = fs.readFileSync(path.join(h.generatedDir, 'extensions_generated.conf'), 'utf8');
    assert.match(file, /\[dst-conference-910\][\s\S]*ConfBridge\(910\)/);
    assert.equal((await get('/conferences', operator)).status, 403);
    assert.equal((await post('/conferences', { number: '911', name: 'x' }, operator)).status, 403);
    assert.equal((await h.agent().get('/api/pbx/conferences')).status, 401);
    const entries = (await h.db.query("SELECT details FROM audit_logs WHERE action = 'pbx.conference.create'")).rows;
    assert.ok(entries.length >= 2);
    assert.ok(!JSON.stringify(entries).includes('5550123') && !JSON.stringify(entries).includes('4321'), 'no PIN in the audit log');
    assert.ok(await auditCount(h.db, "action = 'pbx.conference.create' AND status = 'failure'") >= 1, 'refused creations are audited');
  });

  test('everyone with a phone sees the rooms to dial, never the PINs', async () => {
    const res = await h.agent().get('/api/conference-rooms').set(operator.auth);
    assert.equal(res.status, 200);
    const r = res.body.rooms.find((x) => x.number === '910');
    assert.deepEqual([r.name, r.protected, r.parties, r.locked], ['Board', true, 0, false]);
    assert.ok(!JSON.stringify(res.body).includes('5550123'));
    assert.equal((await h.agent().get('/api/conference-rooms')).status, 401);
  });
});

describe('conference rooms: live state and controls', () => {
  let h; let admin; let id;
  const ami = () => h.ami;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    const made = await h.agent().post('/api/pbx/conferences').set(admin.auth).send({ number: '900', name: 'Team' });
    id = made.body.conference.id;
  });
  after(async () => h.cleanup());

  const inRoom = () => {
    ami().responses.set('ConfbridgeListRooms', { response: 'Success', events: [{ Event: 'ConfbridgeListRooms', Conference: '900', Parties: '2', Marked: '0', Locked: 'No', Muted: 'No' }, { Event: 'ConfbridgeListRooms', Conference: 'evil;', Parties: '1' }] });
    ami().responses.set('ConfbridgeList', { response: 'Success', events: [
      { Event: 'ConfbridgeList', Conference: '900', CallerIDNum: '1001', CallerIDName: 'Office', Channel: 'PJSIP/1001-00000007', Admin: 'Yes', Muted: 'No', Talking: 'Yes' },
      { Event: 'ConfbridgeList', Conference: '900', CallerIDNum: '5551234', CallerIDName: '<unknown>', Channel: 'PJSIP/trk-acme-00000008', Admin: 'No', Muted: 'Yes', Talking: 'No' },
    ] });
  };

  test('status lists who is in each room, with extensions recognised and bad names ignored', async () => {
    ami().reset();
    inRoom();
    const res = await h.agent().get('/api/pbx/conferences/status').set(admin.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.rooms.length, 1);
    const r = res.body.rooms[0];
    assert.deepEqual([r.number, r.parties, r.locked], ['900', 2, false]);
    assert.deepEqual(r.participants.map((p) => [p.extension, p.caller, p.admin, p.muted, p.talking]), [['1001', '1001', true, false, true], [null, '5551234', false, true, false]]);
    const rooms = await h.agent().get('/api/conference-rooms').set(admin.auth);
    assert.equal(rooms.body.rooms[0].parties, 2);
  });

  test('mute, unmute and kick only reach people who are in the room right now', async () => {
    ami().reset();
    inRoom();
    const act = (action, body) => h.agent().post(`/api/pbx/conferences/${id}/${action}`).set(admin.auth).send(body);
    assert.equal((await act('mute', { channel: 'PJSIP/1001-00000007' })).status, 200);
    assert.deepEqual(ami().callsFor('ConfbridgeMute').map((c) => [c.Conference, c.Channel]), [['900', 'PJSIP/1001-00000007']]);
    assert.equal((await act('unmute', { channel: 'PJSIP/1001-00000007' })).status, 200);
    assert.equal((await act('kick', { channel: 'PJSIP/trk-acme-00000008' })).status, 200);
    assert.equal(ami().callsFor('ConfbridgeKick').length, 1);
    const gone = await act('kick', { channel: 'PJSIP/1002-00000009' });
    assert.equal(gone.status, 409);
    assert.match(gone.body.error.message, /no longer in the room/);
    assert.equal(ami().callsFor('ConfbridgeKick').length, 1, 'nothing was sent to Asterisk');
    assert.equal((await act('kick', { channel: 'x; Hangup' })).status, 400);
    assert.equal((await act('kick', {})).status, 400);
    assert.equal((await act('promote', { channel: 'PJSIP/1001-00000007' })).status, 404);
  });

  test('lock and unlock the room; every control is audited; AMI down is reported', async () => {
    ami().reset();
    inRoom();
    const act = (action) => h.agent().post(`/api/pbx/conferences/${id}/${action}`).set(admin.auth).send({});
    const before = await auditCount(h.db, "action LIKE 'pbx.conference.%' AND action NOT IN ('pbx.conference.create')");
    assert.equal((await act('lock')).status, 200);
    assert.equal((await act('unlock')).status, 200);
    assert.deepEqual([ami().callsFor('ConfbridgeLock').length, ami().callsFor('ConfbridgeUnlock').length], [1, 1]);
    assert.equal(await auditCount(h.db, "action LIKE 'pbx.conference.%' AND action NOT IN ('pbx.conference.create')"), before + 2);
    ami().setConnected(false);
    assert.equal((await act('lock')).status, 409);
    assert.deepEqual((await h.agent().get('/api/pbx/conferences/status').set(admin.auth)).body, { available: false, rooms: [] });
    ami().setConnected(true);
  });

  test('room events reach the dashboards', async () => {
    const seen = [];
    h.conferenceService.onChange = (c) => seen.push(c);
    h.ami.emit('event', { Event: 'ConfbridgeJoin', Conference: '900', Channel: 'PJSIP/1001-00000007' });
    h.ami.emit('event', { Event: 'ConfbridgeLeave', Conference: '900' });
    h.ami.emit('event', { Event: 'ConfbridgeJoin', Conference: 'not-a-room' });
    assert.deepEqual(seen, [{ room: '900' }, { room: '900' }]);
  });
});
