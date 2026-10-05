'use strict';
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, auditCount } = require('./helpers');

describe('call origination and hangup', () => {
  let h; let admin; let operator; let plain;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.caller', role: 'operator', extension: '1001' });
    plain = await h.makeUser({ username: 'just.viewer', role: 'user' });
  });
  after(async () => h.cleanup());
  beforeEach(() => {
    h.reset();
  });

  const originate = (body, who) => h.agent().post('/api/originate').set(who.auth).send(body);

  test('a valid originate sends exactly the expected AMI Originate and is audited', async () => {
    const res = await originate({ from: '1001', to: '1002' }, operator);
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'queued');
    const sent = h.ami.callsFor('Originate');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      Action: 'Originate',
      Channel: 'Local/1001@originate-leg/n',
      Context: 'default',
      Exten: '1002',
      Priority: '1',
      CallerID: '"Office" <1001>',
      Timeout: '30000',
      Async: 'true',
    });
    assert.equal(await auditCount(h.db, "action = 'call.originate' AND status = 'success' AND target = '1001->1002' AND username = 'op.caller'"), 1);
  });

  test('admin may originate in the other direction; numeric extensions are accepted', async () => {
    const res = await originate({ from: 1002, to: 1001 }, admin);
    assert.equal(res.status, 202);
    assert.equal(h.ami.callsFor('Originate')[0].Exten, '1001');
    assert.equal(h.ami.callsFor('Originate')[0].Channel, 'Local/1002@originate-leg/n');
  });

  test('invalid, injected or unexpected destinations are rejected and never reach AMI', async () => {
    const bad = [
      { from: '1001', to: '1003' },
      { from: '1001', to: '700' },
      { from: '1001', to: '600' },
      { from: '1001', to: '1001' },
      { from: '1001', to: '1002\r\nAction: Command\r\nCommand: core stop now' },
      { from: '1001', to: '1002;Hangup' },
      { from: 'PJSIP/1001', to: '1002' },
      { from: '1001', to: '1002', channel: 'PJSIP/9999' },
      { from: '1001', to: '1002', context: 'from-trunk' },
      { from: '1001', to: '1002', application: 'System' },
      { from: '1001' },
      { to: '1002' },
      {},
      { from: ['1001'], to: '1002' },
      { from: { $ne: null }, to: '1002' },
    ];
    for (const body of bad) {
      const res = await originate(body, operator);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(h.ami.callsFor('Originate').length, 0);
    assert.equal(h.ami.calls.filter((c) => c.Action !== 'PJSIPShowEndpoints').length, 0, 'no AMI traffic at all');
  });

  test('unauthorised callers are rejected before anything is sent to AMI', async () => {
    assert.equal((await originate({ from: '1001', to: '1002' }, plain)).status, 403);
    assert.equal((await h.agent().post('/api/originate').send({ from: '1001', to: '1002' })).status, 401);
    assert.equal(h.ami.callsFor('Originate').length, 0);
  });

  test('offline endpoints are refused with a meaningful 409 and audited as failures', async () => {
    h.ami.emit('event', { Event: 'ContactStatus', EndpointName: '1002', ContactStatus: 'Removed' });
    h.ami.emit('event', { Event: 'DeviceStateChange', Device: 'PJSIP/1002', State: 'UNAVAILABLE' });
    const res = await originate({ from: '1001', to: '1002' }, operator);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'destination_offline');
    assert.equal(h.ami.callsFor('Originate').length, 0);
    assert.ok((await auditCount(h.db, "action = 'call.originate' AND status = 'failure' AND details->>'reason' = 'destination_offline'")) >= 1);
  });

  test('a busy source is refused', async () => {
    h.ami.emit('event', { Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'INUSE' });
    const res = await originate({ from: '1001', to: '1002' }, operator);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'source_busy');
  });

  test('when AMI is down the API says so (503) and audits the failure', async () => {
    h.ami.setConnected(false);
    const res = await originate({ from: '1001', to: '1002' }, operator);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'ami_unavailable');
    assert.ok((await auditCount(h.db, "action = 'call.originate' AND status = 'failure' AND details->>'reason' = 'ami_unavailable'")) >= 1);
  });

  test('an AMI refusal becomes a 502 with a safe message', async () => {
    h.ami.responses.set('Originate', { response: 'Error', message: 'Permission denied: internal detail', events: [], fields: {} });
    const res = await originate({ from: '1001', to: '1002' }, operator);
    assert.equal(res.status, 502);
    assert.doesNotMatch(JSON.stringify(res.body), /internal detail/);
  });

  test('asynchronous originate failures reported by Asterisk are audited', async () => {
    const { watchOriginateResults } = require('../src/calls/routes');
    watchOriginateResults({ ami: h.ami, audit: h.audit });
    h.ami.emit('event', { Event: 'OriginateResponse', Response: 'Failure', Reason: '5', Channel: 'Local/1001@originate-leg/n', Exten: '1002' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await auditCount(h.db, "action = 'call.originate.result' AND status = 'failure' AND target = '1001->1002'"), 1);
  });

  test('hangup targets only the live channels of the requested configured extension', async () => {
    h.ami.emit('event', { Event: 'Newchannel', Channel: 'PJSIP/1002-0000001a', Uniqueid: 'u1' });
    h.ami.emit('event', { Event: 'Newchannel', Channel: 'PJSIP/1001-0000001b', Uniqueid: 'u2' });
    const res = await h.agent().post('/api/hangup').set(operator.auth).send({ extension: '1002' });
    assert.equal(res.status, 200);
    const hung = h.ami.callsFor('Hangup');
    assert.deepEqual(hung.map((c) => c.Channel), ['PJSIP/1002-0000001a']);
    assert.equal(await auditCount(h.db, "action = 'call.hangup' AND target = '1002' AND status = 'success'"), 1);
  });

  test('hangup rejects arbitrary extensions/channels and idle extensions', async () => {
    assert.equal((await h.agent().post('/api/hangup').set(operator.auth).send({ extension: '9999' })).status, 400);
    assert.equal((await h.agent().post('/api/hangup').set(operator.auth).send({ extension: '1001', channel: 'PJSIP/x' })).status, 400);
    assert.equal((await h.agent().post('/api/hangup').set(plain.auth).send({ extension: '1001' })).status, 403);
    h.ami.emit('event', { Event: 'Hangup', Uniqueid: 'u1', Channel: 'PJSIP/1002-0000001a' });
    h.ami.emit('event', { Event: 'Hangup', Uniqueid: 'u2', Channel: 'PJSIP/1001-0000001b' });
    const idle = await h.agent().post('/api/hangup').set(operator.auth).send({ extension: '1001' });
    assert.equal(idle.status, 409);
    assert.equal(idle.body.error.code, 'no_active_call');
  });
});
