'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const { createHarness } = require('./helpers');
const { createSocketServer } = require('../src/socket');

const waitFor = async (fn, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('socket.io real-time channel', () => {
  let h; let server; let url; let sockApi; let admin; let operator; let plain;
  const clients = [];
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'sock.op', role: 'operator', extension: '1001' });
    plain = await h.makeUser({ username: 'sock.user', role: 'user' });
    server = http.createServer(h.app);
    sockApi = createSocketServer({ httpServer: server, authService: h.authService, state: h.state, paging: h.paging, ami: h.ami, registry: h.registry, trunkStatus: h.trunkStatus, applier: h.applier, logger: h.logger });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    for (const c of clients) c.close();
    sockApi.io.close();
    await h.cleanup();
  });

  function open(auth) {
    const token = auth ? auth.replace(/^Bearer /, '') : undefined;
    const c = connect(url, { transports: ['websocket'], reconnection: false, auth: token ? { token } : {} });
    clients.push(c);
    const got = [];
    c.onAny((name, payload) => got.push({ name, payload }));
    return { c, got };
  }
  const connected = (c) => new Promise((res, rej) => { c.on('connect', res); c.on('connect_error', rej); });

  test('unauthenticated connections are refused', async () => {
    const { c } = open(null);
    await assert.rejects(connected(c), /unauthorized/);
    const bad = open('Bearer not.a.token');
    await assert.rejects(connected(bad.c), /unauthorized/);
  });

  test('a browser-style handshake with the HttpOnly session cookie is accepted', async () => {
    // Browsers cannot set headers on a websocket; they send the session cookie. Polling carries cookie headers in Node.
    const c = connect(url, { transports: ['polling'], reconnection: false, extraHeaders: { Cookie: `session=${operator.token}` } });
    clients.push(c);
    const got = [];
    c.onAny((name) => got.push(name));
    await connected(c);
    await waitFor(() => got.includes('extension.snapshot'), 3000, 'snapshot via cookie auth');
    const bad = connect(url, { transports: ['polling'], reconnection: false, extraHeaders: { Cookie: 'session=forged.token.value' } });
    clients.push(bad);
    await assert.rejects(connected(bad), /unauthorized/);
  });

  test('authenticated clients receive a snapshot, then live extension changes', async () => {
    const { c, got } = open(operator.auth.Authorization);
    await connected(c);
    await waitFor(() => got.some((g) => g.name === 'extension.snapshot'), 3000, 'snapshot');
    const snap = got.find((g) => g.name === 'extension.snapshot').payload;
    assert.deepEqual(snap.map((s) => s.extension), ['1001', '1002']);
    h.ami.register('1002');
    await waitFor(() => got.some((g) => g.name === 'extension.status.changed' && g.payload.extension === '1002' && g.payload.state === 'Online'), 3000, 'status change');
  });

  test('call and paging events are broadcast', async () => {
    const { c, got } = open(operator.auth.Authorization);
    await connected(c);
    h.ami.emit('event', { Event: 'DialEnd', DialStatus: 'ANSWER', Channel: 'PJSIP/1001-0000000a', DestChannel: 'PJSIP/1002-0000000b', UniqueID: 'sc-1' });
    await waitFor(() => got.some((g) => g.name === 'call.started' && g.payload.from === '1001'));
    h.ami.emit('event', { Event: 'Hangup', Channel: 'PJSIP/1001-0000000a', Uniqueid: 'sc-1' });
    await waitFor(() => got.some((g) => g.name === 'call.ended'));

    h.ami.register('1001');
    await h.agent().post('/api/page').set(operator.auth).send({ group: '700' });
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageStarted', Group: '700', Caller: '1001' });
    await waitFor(() => got.some((g) => g.name === 'paging.started' && g.payload.group === '700'));
    h.ami.emit('event', { Event: 'UserEvent', UserEvent: 'PageEnded', Group: '700', Caller: '1001' });
    await waitFor(() => got.some((g) => g.name === 'paging.ended'));
  });

  test('AMI status events go to administrators only', async () => {
    const a = open(admin.auth.Authorization);
    const u = open(plain.auth.Authorization);
    await Promise.all([connected(a.c), connected(u.c)]);
    await waitFor(() => a.got.some((g) => g.name === 'ami.snapshot'));
    h.ami.setConnected(false);
    await waitFor(() => a.got.some((g) => g.name === 'ami.disconnected'));
    h.ami.setConnected(true);
    await waitFor(() => a.got.some((g) => g.name === 'ami.connected'));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(u.got.some((g) => g.name.startsWith('ami.')), false, 'non-admins never see AMI events');
    // ...but they do see extension state turn Unknown while telephony is down
    assert.ok(u.got.some((g) => g.name === 'extension.status.changed' && g.payload.state === 'Unknown'));
  });

  test('sockets of a user are dropped when their access changes', async () => {
    const { c } = open(plain.auth.Authorization);
    await connected(c);
    const closed = new Promise((r) => c.on('disconnect', r));
    sockApi.disconnectUser(plain.id);
    await closed;
    assert.equal(c.connected, false);
  });
});
