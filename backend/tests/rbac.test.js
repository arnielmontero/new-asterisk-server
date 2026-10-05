'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');

// Every protected endpoint, who may call it, and a valid body for the allowed case.
const ENDPOINTS = [
  { name: 'list users', method: 'get', path: '/api/users', roles: ['admin'] },
  { name: 'audit log', method: 'get', path: '/api/audit', roles: ['admin'] },
  { name: 'system status', method: 'get', path: '/api/system/status', roles: ['admin'] },
  { name: 'extension status', method: 'get', path: '/api/extensions', roles: ['admin', 'operator', 'user'] },
  { name: 'originate', method: 'post', path: '/api/originate', body: { from: '1001', to: '1002' }, roles: ['admin', 'operator'] },
  { name: 'hangup', method: 'post', path: '/api/hangup', body: { extension: '1001' }, roles: ['admin', 'operator'] },
  { name: 'page', method: 'post', path: '/api/page', body: { group: '701' }, roles: ['admin', 'operator'] },
  { name: 'current page', method: 'get', path: '/api/page', roles: ['admin', 'operator'] },
  { name: 'sip config', method: 'get', path: '/api/sip/config', roles: ['admin', 'operator'] },
];

describe('role-based access control (enforced on the backend)', () => {
  let h; let admin; let operator; let plain;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    await h.users.update(admin.id, { extension: '1002' });
    operator = await h.makeUser({ username: 'op.erator', role: 'operator', extension: '1001' });
    plain = await h.makeUser({ username: 'plain.user', role: 'user' });
    h.ami.register('1001');
    h.ami.register('1002');
  });
  after(async () => h.cleanup());

  const call = (ep, who) => {
    let req = h.agent()[ep.method](ep.path);
    if (who) req = req.set(who.auth);
    return ep.body ? req.send(ep.body) : req;
  };
  // Allowed means "got past authentication and authorisation" - the business outcome may still be 2xx/4xx/5xx.
  const isDenied = (status) => status === 401 || status === 403;

  for (const ep of ENDPOINTS) {
    test(`${ep.name}: unauthenticated is rejected with 401`, async () => {
      assert.equal((await call(ep, null)).status, 401);
    });

    test(`${ep.name}: user role ${ep.roles.includes('user') ? 'allowed' : 'denied with 403'}`, async () => {
      const res = await call(ep, plain);
      if (ep.roles.includes('user')) assert.ok(!isDenied(res.status), `got ${res.status}`);
      else assert.equal(res.status, 403);
    });

    test(`${ep.name}: operator ${ep.roles.includes('operator') ? 'allowed' : 'denied with 403'}`, async () => {
      // a fresh operator state each time: free the paging slot between page tests
      if (h.paging.active) h.paging.finish('test-reset');
      const res = await call(ep, operator);
      if (ep.roles.includes('operator')) assert.ok(!isDenied(res.status), `got ${res.status}`);
      else assert.equal(res.status, 403);
    });

    test(`${ep.name}: admin allowed`, async () => {
      if (h.paging.active) h.paging.finish('test-reset');
      const res = await call(ep, admin);
      assert.ok(!isDenied(res.status), `got ${res.status}`);
    });
  }

  test('the role in a token is not trusted: demoting a user takes effect immediately', async () => {
    const victim = await h.makeUser({ username: 'soon.demoted', role: 'operator', extension: null });
    assert.equal((await h.agent().post('/api/originate').set(victim.auth).send({ from: '1001', to: '1002' })).status !== 403, true);
    await h.users.update(victim.id, { role: 'user' });
    // old token: token_version no longer matches
    assert.equal((await h.agent().get('/api/extensions').set(victim.auth)).status, 401);
    // fresh login: role from the database is now "user"
    const again = await h.login('soon.demoted', victim.password);
    assert.equal(again.body.user.role, 'user');
    assert.equal((await h.agent().post('/api/originate').set({ Authorization: `Bearer ${again.body.token}` }).send({ from: '1001', to: '1002' })).status, 403);
  });

  test('unknown API paths return a JSON 404 (for authenticated callers)', async () => {
    const res = await h.agent().get('/api/does-not-exist').set(admin.auth);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });
});
