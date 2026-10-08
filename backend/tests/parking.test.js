'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');

const parked = (slot, over = {}) => ({
  Event: 'ParkedCall', ParkingSpace: slot, ParkeeChannel: `PJSIP/trk-acme-0000000${slot.slice(-1)}`, ParkeeUniqueid: `1700000000.${slot}`,
  ParkeeCallerIDNum: '5551234', ParkeeCallerIDName: 'Customer', ParkerDialString: 'PJSIP/1002', ParkingTimeout: '120', ParkingDuration: '0', Parkinglot: 'default', ...over,
});

describe('call parking', () => {
  let h; let admin; let operator;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.park', role: 'operator', extension: '1001' });
  });
  after(async () => h.cleanup());

  const list = (who = operator) => h.agent().get('/api/parking').set(who.auth);

  test('a parked call appears with its slot, caller, who parked it and the time left', async () => {
    const seen = [];
    h.parking.on('change', (l) => seen.push(l));
    h.ami.emit('event', parked('751'));
    const res = await list();
    assert.equal(res.status, 200);
    assert.equal(res.body.parked.length, 1);
    const p = res.body.parked[0];
    assert.deepEqual([p.slot, p.caller, p.name, p.parkedBy], ['751', '5551234', 'Customer', '1002']);
    assert.ok(p.secondsLeft > 115 && p.secondsLeft <= 120);
    assert.equal(seen.length, 1, 'dashboards are told');
  });

  test('slots are listed in order; a made-up slot, parker or caller name is ignored or neutralised', async () => {
    h.ami.emit('event', parked('753', { ParkerDialString: 'Local/x;1@evil', ParkeeCallerIDName: '<unknown>' }));
    h.ami.emit('event', parked('752', { ParkerDialString: 'PJSIP/1001-phone' }));
    h.ami.emit('event', parked('999'));
    h.ami.emit('event', parked('75', { ParkeeUniqueid: 'x' }));
    const res = (await list()).body.parked;
    assert.deepEqual(res.map((p) => p.slot), ['751', '752', '753']);
    assert.equal(res[1].parkedBy, '1001', 'a physical phone counts as its extension');
    assert.equal(res[2].parkedBy, null);
    assert.equal(res[2].name, '');
  });

  test('a call leaves its slot when it is picked up, times out or the caller gives up', async () => {
    h.ami.emit('event', { Event: 'UnParkedCall', ParkeeUniqueid: '1700000000.751', ParkeeChannel: 'PJSIP/trk-acme-00000001' });
    assert.deepEqual((await list()).body.parked.map((p) => p.slot), ['752', '753']);
    h.ami.emit('event', { Event: 'ParkedCallTimeOut', ParkeeUniqueid: '1700000000.752' });
    h.ami.emit('event', { Event: 'ParkedCallGiveUp', ParkeeUniqueid: '1700000000.753' });
    assert.deepEqual((await list()).body.parked, []);
    h.ami.emit('event', { Event: 'UnParkedCall', ParkeeUniqueid: 'nobody' });
    assert.deepEqual((await list()).body.parked, []);
  });

  test('after a reconnect the list is rebuilt from Asterisk; while it is down nothing is claimed', async () => {
    h.ami.emit('event', parked('754'));
    h.ami.responses.set('ParkedCalls', { response: 'Success', events: [parked('755', { ParkingTimeout: '30', ParkingDuration: '90' })] });
    await h.parking.sync();
    const now = (await list()).body.parked;
    assert.deepEqual(now.map((p) => p.slot), ['755'], 'the stale slot is gone');
    assert.ok(now[0].secondsLeft <= 30 && now[0].secondsLeft > 25);
    h.ami.setConnected(false);
    assert.deepEqual((await list()).body.parked, []);
    h.ami.setConnected(true);
    h.ami.responses.clear();
  });

  test('only signed-in users see the list', async () => {
    assert.equal((await h.agent().get('/api/parking')).status, 401);
    assert.equal((await list(admin)).status, 200);
  });

  test('the parking numbers cannot be used for anything else', async () => {
    const post = (url, body) => h.agent().post(`/api/pbx${url}`).set(admin.auth).send(body);
    for (const n of ['750', '751', '759']) {
      const res = await post('/extensions', { number: n, display_name: 'Clash' });
      assert.equal(res.status, 409, n);
      assert.match(res.body.error.message, /reserved/);
      assert.equal((await post('/queues', { number: n, name: 'Clash', members: ['1001'] })).status, 409);
      assert.equal((await post('/conferences', { number: n, name: 'Clash' })).status, 409);
    }
    assert.equal((await post('/extensions', { number: '760', display_name: 'Fine' })).status, 201);
  });
});
