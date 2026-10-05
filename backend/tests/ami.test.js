'use strict';
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { AmiClient, parseFrame } = require('../src/ami/client');
const { createLogger } = require('../src/logger');
const { MockAmi } = require('./mock-ami');

const FAST = { initialMs: 50, maxMs: 200, factor: 2 };
const waitFor = async (fn, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('AMI client', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()().catch(() => {});
  });

  async function setup({ secret = 'mock-secret', clientSecret = secret, client: opts = {} } = {}) {
    const server = new MockAmi({ secret });
    const port = await server.listen();
    const client = new AmiClient({
      host: '127.0.0.1', port, username: 'mock', secret: clientSecret,
      logger: createLogger('silent'), backoff: FAST, pingIntervalMs: 100000, ...opts,
    });
    cleanups.push(() => client.stop(), () => server.close());
    return { server, client, port };
  }

  test('parseFrame handles values containing colons and multi-line Output', () => {
    const msg = parseFrame('Response: Success\r\nMessage: a: b: c\r\nOutput: one\r\nOutput: two');
    assert.equal(msg.Message, 'a: b: c');
    assert.equal(msg.Output, 'one\ntwo');
  });

  test('connects, authenticates and reports connection state', async () => {
    const { client } = await setup();
    const states = [];
    client.on('state', (s) => states.push(s));
    client.start();
    await waitFor(() => client.isConnected(), 3000, 'connected');
    assert.deepEqual(states, ['connecting', 'connected']);
    assert.equal(client.status().state, 'connected');
    assert.match(client.status().banner, /Asterisk Call Manager/);
  });

  test('actions are correlated to their own responses, even concurrently', async () => {
    const { client } = await setup();
    client.start();
    await waitFor(() => client.isConnected());
    const [a, b, c] = await Promise.all([
      client.action({ Action: 'Echo', Value: 'alpha' }),
      client.action({ Action: 'Echo', Value: 'beta' }),
      client.action({ Action: 'Command', Command: 'core show version' }),
    ]);
    assert.equal(a.fields.Echoed, 'alpha');
    assert.equal(b.fields.Echoed, 'beta');
    assert.equal(c.fields.Output, 'line one');
  });

  test('event-list actions resolve with all events once the list completes', async () => {
    const { client } = await setup();
    client.start();
    await waitFor(() => client.isConnected());
    const res = await client.action({ Action: 'PJSIPShowEndpoints' });
    assert.equal(res.response, 'Success');
    assert.deepEqual(res.events.map((e) => e.ObjectName), ['1001', '1002']);
  });

  test('unsolicited events are emitted to listeners', async () => {
    const { client, server } = await setup();
    client.start();
    await waitFor(() => client.isConnected());
    const got = [];
    client.on('event', (e) => got.push(e));
    server.broadcastEvent({ Event: 'ContactStatus', EndpointName: '1001', ContactStatus: 'Reachable' });
    await waitFor(() => got.length === 1);
    assert.equal(got[0].EndpointName, '1001');
  });

  test('an AMI error response is returned to the caller, not thrown', async () => {
    const { client } = await setup();
    client.start();
    await waitFor(() => client.isConnected());
    const res = await client.action({ Action: 'DoesNotExist' });
    assert.equal(res.response, 'Error');
  });

  test('actions fail fast when not connected, and CR/LF injection in fields is refused', async () => {
    const { client } = await setup();
    await assert.rejects(client.action({ Action: 'Ping' }), /not connected/);
    client.start();
    await waitFor(() => client.isConnected());
    await assert.rejects(client.action({ Action: 'Echo', Value: 'x\r\nAction: Command\r\nCommand: core stop now' }), /Invalid characters/);
  });

  test('wrong credentials never connect and keep retrying with backoff', async () => {
    const { client, server } = await setup({ clientSecret: 'wrong-secret' });
    client.start();
    await waitFor(() => server.logins >= 3, 4000, 'repeated login attempts');
    assert.notEqual(client.state, 'connected');
    assert.match(client.status().banner || '', /Asterisk Call Manager/);
  });

  test('reconnects automatically after Asterisk drops the connection (restart) and resets backoff', async () => {
    const { client, server } = await setup();
    const events = [];
    client.on('connected', () => events.push('connected'));
    client.on('disconnected', () => events.push('disconnected'));
    client.start();
    await waitFor(() => client.isConnected());
    const t0 = Date.now();
    server.dropClients();
    await waitFor(() => events.length >= 3 && client.isConnected(), 3000, 'reconnect');
    assert.deepEqual(events, ['connected', 'disconnected', 'connected']);
    assert.ok(Date.now() - t0 < 2000, 'recovers quickly');
    assert.equal(client.status().reconnectAttempt, 0, 'backoff is reset after a successful connection');
    // and the new connection actually works
    assert.equal((await client.action({ Action: 'Echo', Value: 'again' })).fields.Echoed, 'again');
  });

  test('reconnects when Asterisk is down for a while: exponential backoff, capped, then recovers', async () => {
    const { client, server, port } = await setup();
    client.start();
    await waitFor(() => client.isConnected());
    await server.close(); // Asterisk gone: port refuses connections
    await waitFor(() => client.status().reconnectAttempt >= 4, 4000, 'several failed attempts');
    assert.notEqual(client.state, 'connected');
    const back = new MockAmi();
    await back.listen(port); // Asterisk comes back on the same port
    cleanups.push(() => back.close());
    await waitFor(() => client.isConnected(), 3000, 'reconnect after outage');
    assert.equal(client.status().reconnectAttempt, 0);
  });

  test('in-flight actions are rejected (not hung) when the link drops', async () => {
    const { client, server } = await setup();
    client.start();
    await waitFor(() => client.isConnected());
    server.respondToPing = false;
    const pending = client.action({ Action: 'Ping' }, { timeoutMs: 5000 });
    server.dropClients();
    await assert.rejects(pending, /closed/);
  });

  test('a dead (half-open) link is detected by missed pings and recovered', async () => {
    const { client, server } = await setup({ client: { pingIntervalMs: 80, pingTimeoutMs: 80 } });
    const events = [];
    client.on('disconnected', () => events.push('disconnected'));
    client.on('connected', () => events.push('connected'));
    client.start();
    await waitFor(() => client.isConnected());
    server.respondToPing = false; // socket stays open but Asterisk stops answering
    await waitFor(() => events.includes('disconnected'), 3000, 'ping timeout detection');
    server.respondToPing = true;
    await waitFor(() => client.isConnected() && events.filter((e) => e === 'connected').length >= 2, 3000, 'recovery after ping failure');
  });

  test('stop() logs off cleanly and does not reconnect', async () => {
    const { client, server } = await setup();
    const actions = [];
    server.on('action', (m) => actions.push(m.Action));
    client.start();
    await waitFor(() => client.isConnected());
    await client.stop();
    assert.equal(client.state, 'disconnected');
    assert.ok(actions.includes('Logoff'));
    const loginsBefore = server.logins;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(server.logins, loginsBefore, 'no reconnect after stop');
  });
});
