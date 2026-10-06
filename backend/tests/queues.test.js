'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, auditCount } = require('./helpers');
const { renderQueues, renderDialplan } = require('../src/pbx/render');
const { queueNumber, memberExtension } = require('../src/queues/service');

const ext = (number, over = {}) => ({ id: Number(number), number, display_name: `E${number}`, secret: 'a'.repeat(14), phone_secret: 'b'.repeat(14), webrtc_enabled: true, phone_enabled: true, allow_outbound: false, outbound_cid: null, enabled: true, dnd: false, fwd_all: null, fwd_busy: null, fwd_noanswer: null, noanswer_secs: 25, ...over });
const queue = (over = {}) => ({ id: 1, number: '800', name: 'Support', strategy: 'ringall', member_timeout: 15, wrapup_secs: 5, max_callers: 0, max_wait_secs: 120, hold_when_empty: false, fail_dest: null, enabled: true, members: ['1001', '1002'], ...over });

describe('queue configuration rendering', () => {
  const snap = (over = {}) => ({ extensions: [ext('1001'), ext('1002'), ext('1003', { enabled: false })], groups: [], trunks: [], inbound: [], outbound: [], queues: [queue()], ...over });

  test('a queue section carries the strategy and timing; members are Local channels watching the extension hint', () => {
    const out = renderQueues(snap({ queues: [queue({ strategy: 'linear', member_timeout: 20, wrapup_secs: 8, max_callers: 7, members: ['1002', '1001', '1003', '4040'] })] }));
    assert.match(out, /\[q-800\]\nstrategy = linear\ntimeout = 20\nretry = 3\nwrapuptime = 8\nmaxlen = 7\nringinuse = no/);
    const members = out.match(/^member => .*$/gm);
    assert.deepEqual(members, [
      'member => Local/1002@queue-member/n,0,E1002,hint:1002@ext-hints',
      'member => Local/1001@queue-member/n,0,E1001,hint:1001@ext-hints',
    ], 'order kept; disabled and unknown extensions left out');
  });

  test('callers cannot wait for nobody unless the queue is set to hold them', () => {
    assert.match(renderQueues(snap()), /joinempty = unavailable,invalid,paused\nleavewhenempty = unavailable,invalid,paused/);
    const hold = renderQueues(snap({ queues: [queue({ hold_when_empty: true })] }));
    assert.ok(!hold.includes('joinempty') && !hold.includes('leavewhenempty'));
  });

  test('disabled queues are not defined at all', () => {
    assert.ok(!renderQueues(snap({ queues: [queue({ enabled: false })] })).includes('[q-800]'));
  });

  test('the dialplan sends callers in, waits at most max_wait, and routes failures to the fall-back', () => {
    const out = renderDialplan(snap({ queues: [queue({ max_wait_secs: 90, fail_dest: { type: 'extension', value: '1001' } })] }));
    const c = out.slice(out.indexOf('[dst-queue-800]'));
    assert.match(c, /Gosub\(sub-hop,s,1\)\n same => n,Queue\(q-800,r,,,90\)/);
    assert.match(c, /"\$\{QUEUESTATUS\}" = "TIMEOUT"[\s\S]*"JOINEMPTY"[\s\S]*"LEAVEUNAVAIL"\]\?fail\)/);
    assert.match(c, /\(fail\),UserEvent\(QueueFailed,Queue: 800,Status: \$\{QUEUESTATUS\},Caller: \$\{CALLERID\(num\)\},Uniqueid: \$\{UNIQUEID\}\)\n same => n,Goto\(dst-extension-1001,s,1\)/);
    assert.match(out, /exten => 800,1,Set\(CDR\(userfield\)=to:\$\{EXTEN\}\)\n same => n,Goto\(dst-queue-800,s,1\)/, 'dialable internally');
    const none = renderDialplan(snap());
    assert.match(none.slice(none.indexOf('[dst-queue-800]')), /\(fail\),UserEvent[\s\S]*Hangup\(34\)/);
  });

  test('every extension gets a combined device-state hint; a disabled queue rejects calls', () => {
    const out = renderDialplan(snap({ queues: [queue({ enabled: false })] }));
    assert.match(out, /\[ext-hints\]\nexten => 1001,hint,PJSIP\/1001&PJSIP\/1001-phone\nexten => 1002,hint,PJSIP\/1002&PJSIP\/1002-phone\n/);
    assert.ok(!out.includes('exten => 1003,hint'));
    assert.match(out.slice(out.indexOf('[dst-queue-800]')), /Hangup\(21\)/);
    assert.ok(!out.includes('exten => 800,1'));
  });

  test('hostile values are refused', () => {
    assert.throws(() => renderQueues(snap({ queues: [queue({ number: '800\n[evil]' })] })), /unsafe/);
    assert.throws(() => renderQueues(snap({ queues: [queue({ strategy: 'ringall\nx = y' })] })), /unsafe/);
    assert.throws(() => renderQueues(snap({ queues: [queue({ members: ['1001\nmember => x'] })], extensions: [ext('1001\nmember => x')] })), /unsafe/);
  });

  test('name helpers only accept our own channels and queues', () => {
    assert.equal(queueNumber('q-800'), '800');
    assert.equal(queueNumber('sales'), null);
    assert.equal(queueNumber('q-80'), null);
    assert.equal(memberExtension('Local/1001@queue-member/n'), '1001');
    assert.equal(memberExtension('PJSIP/1001'), null);
  });
});

describe('queues: API, status, pause and statistics', () => {
  let h; let admin; let operator; let plain;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.queue', role: 'operator', extension: '1001' });
    plain = await h.makeUser({ username: 'plain.queue', role: 'user' });
  });
  after(async () => h.cleanup());

  const post = (url, body, who = admin) => h.agent().post(`/api/pbx${url}`).set(who.auth).send(body);
  const patch = (url, body, who = admin) => h.agent().patch(`/api/pbx${url}`).set(who.auth).send(body);
  const get = (url, who = admin) => h.agent().get(`/api/pbx${url}`).set(who.auth);
  const del = (url, who = admin) => h.agent().delete(`/api/pbx${url}`).set(who.auth);

  test('create keeps member order; settings and members are validated; numbers are shared', async () => {
    const res = await post('/queues', { number: '800', name: 'Support', strategy: 'linear', members: ['1002', '1001'], max_wait_secs: 60 });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.queue.members, ['1002', '1001']);
    assert.equal(res.body.queue.member_timeout, 15);
    for (const bad of [
      { number: '801', name: 'x', members: [] },
      { number: '801', name: 'x', members: ['9999'] },
      { number: '801', name: 'x', members: ['1001'], strategy: 'weighted' },
      { number: '801', name: 'x', members: ['1001'], member_timeout: 1 },
      { number: '801', name: 'x', members: ['1001'], max_wait_secs: 5 },
      { number: '801', name: 'x', members: ['1001'], max_callers: -1 },
      { number: '801', name: 'x;y', members: ['1001'] },
      { number: '801', name: 'x', members: ['1001'], fail_dest: { type: 'queue', value: '777' } },
      { number: '801', name: 'x', members: ['1001'], extra: 1 },
    ]) assert.equal((await post('/queues', bad)).status, 400, JSON.stringify(bad));
    for (const number of ['800', '1001', '700', '600']) assert.equal((await post('/queues', { number, name: 'Clash', members: ['1001'] })).status, 409, number);
    assert.equal((await post('/extensions', { number: '800', display_name: 'Clash' })).status, 409);
    assert.equal((await post('/ring-groups', { number: '800', name: 'Clash', members: ['1001'] })).status, 409);
    assert.equal((await post('/ivrs', { number: '800', name: 'Clash' })).status, 409);
  });

  test('update, fall-back rules and delete protection', async () => {
    const q = (await get('/queues')).body.queues[0];
    const upd = await patch(`/queues/${q.id}`, { members: ['1001'], strategy: 'ringall', hold_when_empty: true, fail_dest: { type: 'extension', value: '1002' } });
    assert.equal(upd.status, 200);
    assert.deepEqual(upd.body.queue.members, ['1001']);
    assert.equal(upd.body.queue.hold_when_empty, true);
    assert.equal((await patch(`/queues/${q.id}`, { fail_dest: { type: 'queue', value: '800' } })).status, 400, 'not to itself');
    await post('/trunks', { name: 'qt', display_name: 'T', auth_mode: 'ip', host: '10.7.7.7' });
    const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'qt');
    const route = await post('/inbound-routes', { name: 'to queue', did: '5558100', trunk_id: trunk.id, destination: { type: 'queue', value: '800' } });
    assert.equal(route.status, 201, 'a queue is a destination');
    const blocked = await del(`/queues/${q.id}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /inbound route "to queue"/);
    const ext1002 = (await get('/extensions')).body.extensions.find((e) => e.number === '1002');
    assert.equal((await del(`/extensions/${ext1002.id}`)).status, 409, 'an extension that is a queue fall-back is protected');
    await del(`/inbound-routes/${route.body.route.id}`);
  });

  test('applying a queue writes queues_generated.conf and reloads queues before the dialplan', async () => {
    await new Promise((r) => setTimeout(r, 600));
    await h.applier.apply('baseline', { force: true });
    h.ami.reset();
    assert.equal((await post('/queues', { number: '810', name: 'Billing', members: ['1002'] })).status, 201);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(h.ami.callsFor('Command').map((c) => c.Command), ['queue reload all', 'dialplan reload']);
    const file = fs.readFileSync(path.join(h.generatedDir, 'queues_generated.conf'), 'utf8');
    assert.match(file, /\[q-810\]/);
    assert.match(file, /member => Local\/1002@queue-member\/n,0,E1002,hint:1002@ext-hints/);
    h.ami.reset();
    const ext = (await get('/extensions')).body.extensions.find((e) => e.number === '1002');
    await patch(`/extensions/${ext.id}`, { dnd: true });
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(h.ami.callsFor('Command').map((c) => c.Command), ['dialplan reload'], 'DND does not reload queues');
    await patch(`/extensions/${ext.id}`, { dnd: false });
  });

  test('changing the agent order of an in-order queue reloads without the queue first, so Asterisk forgets the old order', async () => {
    const made = await post('/queues', { number: '830', name: 'Ordered', strategy: 'linear', members: ['1001', '1002'] });
    assert.equal(made.status, 201);
    await new Promise((r) => setTimeout(r, 600));
    await h.applier.apply('baseline', { force: true });
    // Record what the queue file contains at each queue reload.
    const seen = [];
    h.ami.reset();
    h.ami.responses.set('Command', (f) => {
      if (f.Command === 'queue reload all') seen.push(fs.readFileSync(path.join(h.generatedDir, 'queues_generated.conf'), 'utf8'));
      return { response: 'Success', fields: { Output: 'ok' }, events: [] };
    });
    assert.equal((await patch(`/queues/${made.body.queue.id}`, { members: ['1002', '1001'] })).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(seen.length, 2, 'two queue reloads');
    assert.ok(!seen[0].includes('[q-830]'), 'first without the queue');
    assert.match(seen[1], /\[q-830\][\s\S]*member => Local\/1002[\s\S]*member => Local\/1001/, 'then with the new order');
    // Another change that keeps the order does not do the dance.
    seen.length = 0;
    assert.equal((await patch(`/queues/${made.body.queue.id}`, { member_timeout: 20 })).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(seen.length, 1);
    // Ring-all queues do not depend on order.
    seen.length = 0;
    const all = await post('/queues', { number: '831', name: 'All', members: ['1001', '1002'] });
    await new Promise((r) => setTimeout(r, 800));
    seen.length = 0;
    await patch(`/queues/${all.body.queue.id}`, { members: ['1002', '1001'] });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(seen.length, 1);
    h.ami.responses.clear();
  });

  test('live status comes from QueueStatus: waiting callers, agent states and pauses', async () => {
    h.ami.responses.set('QueueStatus', {
      response: 'Success', fields: {},
      events: [
        { Event: 'QueueParams', Queue: 'q-800', Calls: '2', Holdtime: '14', Completed: '5', Abandoned: '1' },
        { Event: 'QueueMember', Queue: 'q-800', Location: 'Local/1001@queue-member/n', Status: '1', Paused: '0', CallsTaken: '3', InCall: '0', LastCall: '1700000000' },
        { Event: 'QueueMember', Queue: 'q-800', Location: 'Local/1002@queue-member/n', Status: '2', Paused: '1', PausedReason: 'lunch', CallsTaken: '1', InCall: '1' },
        { Event: 'QueueEntry', Queue: 'q-800', Position: '1', CallerIDNum: '15551234567', CallerIDName: 'Bob', Wait: '9' },
        { Event: 'QueueParams', Queue: 'somebody-elses', Calls: '9' },
      ],
    });
    const s = (await get('/queues/status')).body;
    assert.equal(s.available, true);
    assert.equal(s.queues.length, 1, 'only queues of this system');
    const q = s.queues[0];
    assert.deepEqual([q.number, q.calls, q.completed, q.abandoned], ['800', 2, 5, 1]);
    assert.deepEqual(q.members.map((m) => [m.extension, m.state, m.paused]), [['1001', 'available', false], ['1002', 'on call', true]]);
    assert.equal(q.members[1].pausedReason, 'lunch');
    assert.deepEqual(q.callers, [{ position: 1, caller: '15551234567', name: 'Bob', waitSecs: 9 }]);
    h.ami.setConnected(false);
    assert.deepEqual((await get('/queues/status')).body, { available: false, queues: [] }, 'nothing is invented while AMI is down');
    h.ami.setConnected(true);
  });

  test('agents see their own queues and can pause and resume; nobody else can', async () => {
    const q = (await get('/queues')).body.queues.find((x) => x.number === '800');
    assert.ok(q.members.includes('1001'));
    const mine = await h.agent().get('/api/my/queues').set(operator.auth);
    assert.equal(mine.status, 200);
    const served = (await get('/queues')).body.queues.filter((x) => x.enabled && x.members.includes('1001')).map((x) => x.number).sort();
    assert.deepEqual(mine.body.queues.map((x) => x.number).sort(), served, 'exactly the queues this extension serves');
    assert.ok(!mine.body.queues.some((x) => x.number === '810'), 'not queues it is not a member of');
    assert.equal(mine.body.queues.find((x) => x.number === '800').waiting, 2);
    h.ami.reset();
    const pause = await h.agent().post('/api/my/queues/pause').set(operator.auth).send({ paused: true });
    assert.equal(pause.status, 200);
    const call = h.ami.callsFor('QueuePause')[0];
    assert.deepEqual([call.Interface, call.Paused, call.Queue], ['Local/1001@queue-member/n', 'true', undefined]);
    assert.equal(await auditCount(h.db, "action = 'queue.pause' AND target = '1001'"), 1);
    await h.agent().post('/api/my/queues/pause').set(operator.auth).send({ paused: false });
    assert.equal(h.ami.callsFor('QueuePause')[1].Paused, 'false');
    assert.equal((await h.agent().post('/api/my/queues/pause').set(operator.auth).send({ paused: 'yes' })).status, 400);
    assert.equal((await h.agent().post('/api/my/queues/pause').set(plain.auth).send({ paused: true })).status, 403);
    assert.equal((await h.agent().get('/api/my/queues').set(plain.auth)).status, 403);
    assert.equal((await h.agent().get('/api/my/queues')).status, 401);
    h.ami.responses.set('QueuePause', { response: 'Error', message: 'Interface not found', fields: {}, events: [] });
    assert.equal((await h.agent().post('/api/my/queues/pause').set(operator.auth).send({ paused: true })).status, 500);
    h.ami.responses.clear();
  });

  test('queue events become statistics: served, abandoned, turned away, waits, service level and per agent', async () => {
    const emit = (e) => h.ami.emit('event', e);
    emit({ Event: 'AgentComplete', Queue: 'q-800', Uniqueid: 'c1', CallerIDNum: '111', Interface: 'Local/1001@queue-member/n', HoldTime: '5', TalkTime: '60' });
    emit({ Event: 'AgentComplete', Queue: 'q-800', Uniqueid: 'c2', CallerIDNum: '222', Interface: 'Local/1002@queue-member/n', HoldTime: '30', TalkTime: '120' });
    emit({ Event: 'AgentComplete', Queue: 'q-800', Uniqueid: 'c2', CallerIDNum: '222', Interface: 'Local/1002@queue-member/n', HoldTime: '30', TalkTime: '120' }); // duplicate event
    emit({ Event: 'QueueCallerAbandon', Queue: 'q-800', Uniqueid: 'c3', CallerIDNum: '333', HoldTime: '12' });
    // A timeout is reported twice: Asterisk calls it an abandon, our dialplan knows the real reason. The reason wins.
    emit({ Event: 'QueueCallerAbandon', Queue: 'q-800', Uniqueid: 'c4', CallerIDNum: '444', HoldTime: '15' });
    await new Promise((r) => setTimeout(r, 100));
    emit({ Event: 'UserEvent', UserEvent: 'QueueFailed', Queue: '800', Status: 'TIMEOUT', Caller: '444', Uniqueid: 'c4' });
    emit({ Event: 'UserEvent', UserEvent: 'QueueFailed', Queue: '800', Status: 'JOINEMPTY', Caller: '555', Uniqueid: 'c5' });
    emit({ Event: 'AgentComplete', Queue: 'not-ours', Uniqueid: 'c6', Interface: 'Local/1001@queue-member/n', HoldTime: '1', TalkTime: '1' });
    emit({ Event: 'UserEvent', UserEvent: 'SomethingElse', Queue: '800', Uniqueid: 'c7' });
    await new Promise((r) => setTimeout(r, 300));
    const s = (await get('/queues/stats?serviceLevel=20')).body;
    assert.equal(s.queues.length, 1);
    const q = s.queues[0];
    assert.equal(q.queue, '800');
    assert.deepEqual([q.offered, q.answered, q.abandoned, q.unserved], [5, 2, 1, 2]);
    assert.equal(q.avg_wait, 18, 'average wait of answered calls (5 and 30)');
    assert.equal(q.avg_talk, 90);
    assert.equal(q.longest_wait, 30);
    assert.equal(q.service_level, 20, '1 of 5 offered calls answered within 20 s');
    assert.deepEqual(s.agents.map((a) => [a.agent, a.calls, a.talk_secs]).sort(), [['1001', 1, 60], ['1002', 1, 120]]);
    const strict = (await get('/queues/stats?serviceLevel=60')).body.queues[0];
    assert.equal(strict.service_level, 40);
    assert.equal((await get('/queues/stats?from=2031-01-01T00:00:00Z')).body.queues.length, 0);
    for (const bad of ['?serviceLevel=0', '?serviceLevel=abc', '?from=nope', '?extra=1']) assert.equal((await get(`/queues/stats${bad}`)).status, 400, bad);
  });

  test('only administrators manage queues and read statistics', async () => {
    for (const r of [get('/queues', operator), get('/queues/status', operator), get('/queues/stats', operator), post('/queues', { number: '820', name: 'X', members: ['1001'] }, operator)]) {
      assert.equal((await r).status, 403);
    }
  });
});
