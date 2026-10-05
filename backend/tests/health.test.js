'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');

describe('health endpoints', () => {
  let h;
  before(async () => {
    h = await createHarness();
  });
  after(async () => h.cleanup());

  test('liveness answers without touching dependencies', async () => {
    const res = await h.agent().get('/health/live');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('/health is 200 only when the database and AMI are both healthy', async () => {
    const res = await h.agent().get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok', checks: { application: 'ok', database: 'ok', ami: 'connected' } });
    assert.equal((await h.agent().get('/api/health')).status, 200, 'also reachable through the /api proxy path');
  });

  test('a running backend with AMI down is reported degraded with 503, never healthy', async () => {
    h.ami.setConnected(false);
    const res = await h.agent().get('/health');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.checks.database, 'ok');
    assert.equal(res.body.checks.ami, 'disconnected');
    assert.equal((await h.agent().get('/health/live')).status, 200, 'liveness is unaffected');
    h.ami.setConnected(true);
    assert.equal((await h.agent().get('/health')).status, 200, 'recovers when AMI returns');
  });

  test('health reveals nothing sensitive', async () => {
    const res = await h.agent().get('/health');
    assert.doesNotMatch(JSON.stringify(res.body), /password|secret|token|version|host/i);
  });

  test('database loss is reported as down with 503', async () => {
    const dead = await createHarness();
    await dead.db.close();
    const res = await dead.agent().get('/health');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'down');
    assert.equal(res.body.checks.database, 'down');
    dead.db.close = async () => {};
    await dead.cleanup();
  });
});
