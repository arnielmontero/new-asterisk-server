'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ExtensionState, normalizeDeviceState } = require('../src/extensions/state');
const { createLogger } = require('../src/logger');
const { extensionFromChannel, extensionFromEndpoint, pagingTargets } = require('../src/extensions/registry');

class StubAmi extends EventEmitter {
  constructor() { super(); this.connected = true; this.responses = {}; }
  isConnected() { return this.connected; }
  async action(f) { return this.responses[f.Action] || { response: 'Success', events: [], fields: {} }; }
}

describe('extension state derivation', () => {
  let ami; let state; let changes;
  beforeEach(() => {
    ami = new StubAmi();
    state = new ExtensionState({ ami, logger: createLogger('silent') });
    state.synced = true;
    changes = [];
    state.on('change', (c) => changes.push(c));
  });
  const ev = (e) => ami.emit('event', e);

  test('registry helpers map endpoints and channels to extensions', () => {
    assert.equal(extensionFromEndpoint('1001'), '1001');
    assert.equal(extensionFromEndpoint('1002-phone'), '1002');
    assert.equal(extensionFromEndpoint('1003'), null);
    assert.equal(extensionFromEndpoint('9999-phone'), null);
    assert.equal(extensionFromChannel('PJSIP/1001-0000002a'), '1001');
    assert.equal(extensionFromChannel('PJSIP/1002-phone-0000002b'), '1002');
    assert.equal(extensionFromChannel('Local/1001@originate-leg-00000001;1'), null);
    assert.deepEqual(pagingTargets('700', '1001'), ['1002']);
    assert.deepEqual(pagingTargets('701', '1001'), []);
    assert.deepEqual(pagingTargets('702', '1001'), ['1002']);
  });

  test('device state strings from different AMI sources are normalised', () => {
    assert.equal(normalizeDeviceState('Not in use'), 'NOT_INUSE');
    assert.equal(normalizeDeviceState('NOT_INUSE'), 'NOT_INUSE');
    assert.equal(normalizeDeviceState('In use'), 'INUSE');
    assert.equal(normalizeDeviceState('INUSE'), 'INUSE');
    assert.equal(normalizeDeviceState('Unavailable'), 'UNAVAILABLE');
    assert.equal(normalizeDeviceState('Ringing'), 'RINGING');
    assert.equal(normalizeDeviceState('Busy'), 'BUSY');
    assert.equal(normalizeDeviceState('whatever'), 'UNKNOWN');
  });

  test('extensions start Offline and become Online on registration (ContactStatus)', () => {
    assert.equal(state.get('1001').state, 'Offline');
    ev({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: 'Created' });
    assert.equal(state.get('1001').state, 'Online');
    assert.equal(state.get('1001').registered, true);
    assert.equal(state.get('1002').state, 'Offline');
    assert.equal(changes.at(-1).extension, '1001');
  });

  test('a physical phone registration also makes the extension Online and is reported separately', () => {
    ev({ Event: 'ContactStatus', EndpointName: '1002-phone', ContactStatus: 'Reachable' });
    const s = state.get('1002');
    assert.equal(s.state, 'Online');
    assert.deepEqual(s.clients, { browser: false, phone: true });
  });

  test('unregistration, unreachability and removal take the extension Offline', () => {
    for (const status of ['Removed', 'Unreachable']) {
      ev({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: 'Reachable' });
      ev({ Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'NOT_INUSE' });
      assert.equal(state.get('1001').state, 'Online');
      ev({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: status });
      ev({ Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'UNAVAILABLE' });
      assert.equal(state.get('1001').state, 'Offline', status);
    }
  });

  test('device state drives In-Call and back to Online', () => {
    ev({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: 'Reachable' });
    ev({ Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'RINGING' });
    assert.equal(state.get('1001').state, 'Online', 'ringing is not yet a call');
    ev({ Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'INUSE' });
    assert.equal(state.get('1001').state, 'In-Call');
    ev({ Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'NOT_INUSE' });
    assert.equal(state.get('1001').state, 'Online');
  });

  test('paging overrides In-Call/Online for the operator and the targets, and clears afterwards', () => {
    for (const e of ['1001', '1002']) ev({ Event: 'ContactStatus', EndpointName: e, ContactStatus: 'Reachable' });
    ev({ Event: 'DeviceStateChange', Device: 'PJSIP/1002', State: 'INUSE' });
    state.setPaging({ group: '700', caller: '1001', targets: ['1002'] });
    assert.equal(state.get('1001').state, 'Paging');
    assert.equal(state.get('1002').state, 'Paging');
    state.setPaging(null);
    assert.equal(state.get('1001').state, 'Online');
    assert.equal(state.get('1002').state, 'In-Call');
  });

  test('state is Unknown (not guessed) while AMI is disconnected, and recovers on resync', async () => {
    ev({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: 'Reachable' });
    ami.connected = false;
    ami.emit('disconnected');
    for (const s of state.snapshot()) {
      assert.equal(s.state, 'Unknown');
      assert.equal(s.registered, null);
    }
    ami.responses.PJSIPShowEndpoints = { response: 'Success', events: [{ Event: 'EndpointList', ObjectName: '1002', DeviceState: 'In use' }], fields: {} };
    ami.responses.PJSIPShowContacts = { response: 'Success', events: [{ Event: 'ContactList', EndpointName: '1002', Status: 'Reachable' }], fields: {} };
    ami.connected = true;
    await state.sync();
    assert.equal(state.get('1002').state, 'In-Call');
    assert.equal(state.get('1001').state, 'Offline', 'a stale registration from before the outage is not trusted');
  });

  test('only real changes are published (no duplicate change events)', () => {
    ev({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: 'Reachable' });
    const n = changes.length;
    ev({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: 'Reachable' });
    ev({ Event: 'DeviceStateChange', Device: 'PJSIP/1001', State: 'NOT_INUSE' });
    assert.equal(changes.length, n);
  });

  test('answered calls between extensions emit call.started / call.ended', () => {
    const log = [];
    state.on('call.started', (c) => log.push(['started', c.from, c.to]));
    state.on('call.ended', (c) => log.push(['ended', c.from, c.to]));
    ev({ Event: 'DialEnd', DialStatus: 'ANSWER', Channel: 'PJSIP/1001-0000000a', DestChannel: 'PJSIP/1002-0000000b', UniqueID: 'call-1' });
    ev({ Event: 'Hangup', Channel: 'PJSIP/1001-0000000a', Uniqueid: 'call-1' });
    assert.deepEqual(log, [['started', '1001', '1002'], ['ended', '1001', '1002']]);
  });

  test('unanswered dials and calls to non-extensions are ignored', () => {
    const log = [];
    state.on('call.started', () => log.push('started'));
    ev({ Event: 'DialEnd', DialStatus: 'NOANSWER', Channel: 'PJSIP/1001-0000000a', DestChannel: 'PJSIP/1002-0000000b', UniqueID: 'x' });
    ev({ Event: 'DialEnd', DialStatus: 'ANSWER', Channel: 'PJSIP/1001-0000000a', DestChannel: 'PJSIP/9999-0000000b', UniqueID: 'y' });
    assert.deepEqual(log, []);
  });

  test('channels are tracked from Newchannel/Hangup for the hangup API', () => {
    ev({ Event: 'Newchannel', Channel: 'PJSIP/1001-00000001', Uniqueid: 'a' });
    ev({ Event: 'Newchannel', Channel: 'PJSIP/1001-phone-00000002', Uniqueid: 'b' });
    ev({ Event: 'Newchannel', Channel: 'PJSIP/1002-00000003', Uniqueid: 'c' });
    assert.deepEqual(state.channelsFor('1001').sort(), ['PJSIP/1001-00000001', 'PJSIP/1001-phone-00000002']);
    ev({ Event: 'Hangup', Channel: 'PJSIP/1001-00000001', Uniqueid: 'a' });
    assert.deepEqual(state.channelsFor('1001'), ['PJSIP/1001-phone-00000002']);
  });
});
