'use strict';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, auditCount } = require('./helpers');

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('paging', () => {
  let h; let admin; let op1002; let op1001; let plain; let noExt;
  before(async () => {
    h = await createHarness({ pagingTtl: 1 });
    admin = await h.seedAdmin();
    op1002 = await h.makeUser({ username: 'op.warehouse', role: 'operator', extension: '1002' });
    op1001 = await h.makeUser({ username: 'op.office', role: 'operator', extension: '1001' });
    noExt = await h.makeUser({ username: 'op.noext', role: 'operator', extension: null });
    plain = await h.makeUser({ username: 'viewer.only', role: 'user' });
  });
  after(async () => h.cleanup());
  beforeEach(() => {
    if (h.paging.active) h.paging.finish('test-reset');
    h.reset();
  });

  const page = (group, who) => h.agent().post('/api/page').set(who.auth).send({ group });
  const stateOf = (ext) => h.state.get(ext).state;

  test('a valid group is authorised: the single-use authorisation is written into Asterisk and the request audited', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await page('701', op1002);
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'authorized');
    assert.equal(res.body.group, '701');
    assert.deepEqual(res.body.targets, ['1001']);
    assert.equal(res.body.extension, '1002');
    const put = h.ami.callsFor('DBPut');
    assert.equal(put.length, 1);
    assert.equal(put[0].Family, 'page_auth');
    assert.equal(put[0].Key, '1002', 'keyed by the operator\'s own extension');
    const [group, expiry] = put[0].Val.split(':');
    assert.equal(group, '701');
    assert.ok(Number(expiry) >= before + 1 && Number(expiry) <= before + 25, 'short-lived');
    assert.equal(h.ami.callsFor('Originate').length, 0, 'the backend never originates a page itself (no mic source)');
    assert.equal(await auditCount(h.db, "action = 'paging.request' AND status = 'success' AND target = '701' AND username = 'op.warehouse'"), 1);
  });

  test('Page All excludes the caller from the targets', async () => {
    const res = await page('700', op1001);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body.targets, ['1002']);
  });

  test('numeric group numbers are accepted', async () => {
    const res = await h.agent().post('/api/page').set(op1002.auth).send({ group: 700 });
    assert.equal(res.status, 202);
  });

  test('invalid groups and extra fields are rejected and nothing is written to Asterisk', async () => {
    const bad = ['703', '699', '600', '1001', 'all', '700; Hangup', '700\r\nAction: Command', '', null, ['700'], { $ne: 1 }];
    for (const group of bad) {
      const res = await page(group, op1002);
      assert.equal(res.status, 400, JSON.stringify(group));
    }
    assert.equal((await h.agent().post('/api/page').set(op1002.auth).send({ group: '700', extension: '1001' })).status, 400);
    assert.equal((await h.agent().post('/api/page').set(op1002.auth).send({})).status, 400);
    assert.equal(h.ami.callsFor('DBPut').length, 0);
    assert.equal(h.paging.current(), null);
  });

  test('the user role and anonymous callers are rejected', async () => {
    assert.equal((await page('700', plain)).status, 403);
    assert.equal((await h.agent().post('/api/page').send({ group: '700' })).status, 401);
    assert.equal(h.ami.callsFor('DBPut').length, 0);
  });

  test('an operator with no assigned extension cannot page (there is no mic source)', async () => {
    const res = await page('700', noExt);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'no_extension');
    assert.equal(h.ami.callsFor('DBPut').length, 0);
    assert.ok((await auditCount(h.db, "action = 'paging.request' AND status = 'failure' AND details->>'reason' = 'no_extension'")) >= 1);
  });

  test('paging a group whose only member is yourself is refused with 422', async () => {
    const res = await page('701', op1001);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'no_targets');
  });

  test('the operator\'s SIP client must actually be registered', async () => {
    h.ami.emit('event', { Event: 'ContactStatus', EndpointName: '1002', ContactStatus: 'Removed' });
    h.ami.emit('event', { Event: 'DeviceStateChange', Device: 'PJSIP/1002', State: 'UNAVAILABLE' });
    const res = await page('700', op1002);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'sip_not_registered');
    assert.equal(h.ami.callsFor('DBPut').length, 0);
  });

  test('when AMI is down the API returns 503 instead of pretending', async () => {
    h.ami.setConnected(false);
    const res = await page('700', op1002);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'ami_unavailable');
  });

  test('concurrent page requests: exactly one wins, the others get 409', async () => {
    const results = await Promise.all([page('700', op1002), page('700', op1001), page('701', admin)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [202, 409, 409]);
    assert.equal(h.ami.callsFor('DBPut').length, 1, 'only the winner is authorised in Asterisk');
    const loser = results.find((r) => r.status === 409);
    assert.equal(loser.body.error.code, 'page_in_progress');
  });

  test('a failed AMI write releases the slot and reports 502', async () => {
    h.ami.responses.set('DBPut', { response: 'Error', message: 'nope', events: [], fields: {} });
    const res = await page('700', op1002);
    assert.equal(res.status, 502);
    assert.equal(h.paging.current(), null);
    h.ami.responses.clear();
    assert.equal((await page('700', op1002)).status, 202, 'a later attempt succeeds');
  });

  test('lifecycle from real dialplan events: started -> live state -> ended', async () => {
    const seen = [];
    h.paging.on('started', (p) => seen.push(['started', p.group]));
    h.paging.on('ended', (p) => seen.push(['ended', p.group, p.reason]));
    const res = await page('700', op1002);
    assert.equal(res.status, 202);
    assert.equal(h.paging.current().status, 'authorized');
    assert.equal(stateOf('1001'), 'Online', 'nothing is "Paging" until Asterisk says the page started');

    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageStarted', Group: '700', Caller: '1002' });
    await tick();
    assert.equal(h.paging.current().status, 'live');
    assert.equal(stateOf('1001'), 'Paging', 'the target shows Paging');
    assert.equal(stateOf('1002'), 'Paging', 'the operator shows Paging');
    assert.equal(await auditCount(h.db, "action = 'paging.success' AND target = '700' AND username = 'op.warehouse'"), 1);

    // while live, a second page is refused
    assert.equal((await page('701', admin)).status, 409);

    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageEnded', Group: '700', Caller: '1002' });
    await tick();
    assert.equal(h.paging.current(), null);
    assert.equal(stateOf('1001'), 'Online');
    assert.equal(stateOf('1002'), 'Online');
    assert.deepEqual(seen, [['started', '700'], ['ended', '700', 'ended']]);
    const end = (await h.db.query("SELECT details FROM audit_logs WHERE action = 'paging.end' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(end.details.group, '700');
    assert.equal(typeof end.details.durationSeconds, 'number');
    h.paging.removeAllListeners('started');
    h.paging.removeAllListeners('ended');
  });

  test('a page denied by the dialplan is audited as a failure and frees the slot', async () => {
    const failed = [];
    h.paging.on('failed', (p) => failed.push(p.reason));
    await page('700', op1002);
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageDenied', Group: '700', Caller: '1002', Reason: 'expired' });
    await tick();
    assert.equal(h.paging.current(), null);
    assert.deepEqual(failed, ['denied:expired']);
    assert.ok((await auditCount(h.db, "action = 'paging.failure' AND status = 'failure' AND details->>'reason' = 'expired'")) >= 1);
    h.paging.removeAllListeners('failed');
  });

  test('an authorisation that is never used expires, is audited as a failure and frees the slot', async () => {
    const failed = [];
    h.paging.on('failed', (p) => failed.push(p.reason));
    await page('700', op1002);
    await tick(3300); // ttl 1s + 2s grace
    assert.equal(h.paging.current(), null);
    assert.deepEqual(failed, ['no_call_received']);
    assert.ok((await auditCount(h.db, "action = 'paging.failure' AND details->>'reason' = 'no_call_received'")) >= 1);
    h.paging.removeAllListeners('failed');
  });

  test('an unrelated page event from another extension does not disturb the active page', async () => {
    await page('700', op1002);
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageEnded', Group: '700', Caller: '1001' });
    await tick();
    assert.ok(h.paging.current());
  });

  test('admins can force-end a page: the operator channels are hung up and the authorisation dropped', async () => {
    h.ami.emit('event', { Event: 'Newchannel', Channel: 'PJSIP/1002-00000042', Uniqueid: 'pg1' });
    await page('700', op1002);
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageStarted', Group: '700', Caller: '1002' });
    await tick();
    const res = await h.agent().delete('/api/page').set(admin.auth);
    assert.equal(res.status, 200);
    assert.deepEqual(h.ami.callsFor('Hangup').map((c) => c.Channel), ['PJSIP/1002-00000042']);
    assert.equal(h.ami.callsFor('DBDel').length, 1);
    assert.equal(await auditCount(h.db, "action = 'paging.cancel' AND username = 'admin'"), 1);
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageEnded', Group: '700', Caller: '1002' });
    await tick();
    assert.equal(h.paging.current(), null);
    assert.equal((await h.agent().delete('/api/page').set(admin.auth)).status, 404);
  });

  test('AMI disconnect ends the tracked page (state is unknown, not faked)', async () => {
    await page('700', op1002);
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageStarted', Group: '700', Caller: '1002' });
    await tick();
    h.ami.setConnected(false);
    assert.equal(h.paging.current(), null);
    assert.equal(stateOf('1001'), 'Unknown');
  });
});
