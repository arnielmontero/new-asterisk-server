'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createHarness, auditCount } = require('./helpers');

describe('authentication', () => {
  let h;
  before(async () => {
    h = await createHarness();
    await h.seedAdmin();
  });
  after(async () => h.cleanup());

  test('valid login returns a JWT, user info and an HttpOnly SameSite=Strict cookie', async () => {
    const res = await h.login('admin', h.config.adminPassword);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'admin');
    assert.equal(res.body.user.role, 'admin');
    assert.ok(res.body.token.split('.').length === 3);
    assert.equal(res.body.user.password_hash, undefined, 'password hash must never be exposed');
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('session='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    const claims = jwt.decode(res.body.token);
    assert.equal(claims.iss, 'comms-stack');
    assert.equal(claims.aud, 'comms-dashboard');
    assert.ok(claims.exp - claims.iat <= 900, 'access token must be short-lived');
    assert.equal(claims.role, undefined, 'role is read from the database, not the token');
  });

  test('login is case-insensitive on username', async () => {
    const res = await h.login('ADMIN', h.config.adminPassword);
    assert.equal(res.status, 200);
  });

  test('wrong password and unknown user fail identically with 401', async () => {
    const wrong = await h.login('admin', 'definitely-not-the-password');
    const unknown = await h.login('nobody-here', 'definitely-not-the-password');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body, 'responses must not reveal which usernames exist');
    assert.equal(wrong.body.error.code, 'invalid_credentials');
    assert.equal(wrong.headers['set-cookie'], undefined);
  });

  test('login success and failure are audited', async () => {
    assert.ok((await auditCount(h.db, "action = 'auth.login' AND status = 'success' AND username = 'admin'")) >= 1);
    assert.ok((await auditCount(h.db, "action = 'auth.login' AND status = 'failure'")) >= 2);
  });

  test('login input is validated (unknown fields, missing fields, wrong types)', async () => {
    assert.equal((await h.agent().post('/api/auth/login').send({ username: 'admin' })).status, 400);
    assert.equal((await h.agent().post('/api/auth/login').send({ username: 'admin', password: 'x', extra: 1 })).status, 400);
    assert.equal((await h.agent().post('/api/auth/login').send({ username: { $ne: '' }, password: 'x' })).status, 400);
  });

  test('requests without a token are rejected', async () => {
    assert.equal((await h.agent().get('/api/auth/me')).status, 401);
  });

  test('a valid token (bearer or cookie) is accepted', async () => {
    const login = await h.login('admin', h.config.adminPassword);
    assert.equal((await h.agent().get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`)).status, 200);
    assert.equal((await h.agent().get('/api/auth/me').set('Cookie', `session=${login.body.token}`)).status, 200);
  });

  test('an expired token is rejected', async () => {
    const admin = await h.users.findAuthByUsername('admin');
    const expired = jwt.sign({ tv: admin.token_version, st: Math.floor(Date.now() / 1000) - 100 }, h.config.jwt.secret, {
      algorithm: 'HS256', subject: String(admin.id), issuer: 'comms-stack', audience: 'comms-dashboard', expiresIn: -10,
    });
    assert.equal((await h.agent().get('/api/auth/me').set('Authorization', `Bearer ${expired}`)).status, 401);
  });

  test('tampered, wrong-secret, wrong-audience and alg=none tokens are rejected', async () => {
    const admin = await h.users.findAuthByUsername('admin');
    const base = { tv: admin.token_version, st: Math.floor(Date.now() / 1000) };
    const opts = { subject: String(admin.id), issuer: 'comms-stack', audience: 'comms-dashboard', expiresIn: 60 };
    const good = jwt.sign(base, h.config.jwt.secret, { ...opts, algorithm: 'HS256' });
    const tampered = `${good.slice(0, -4)}AAAA`;
    const wrongSecret = jwt.sign(base, 'some-other-secret-some-other-secret-1234', { ...opts, algorithm: 'HS256' });
    const wrongAud = jwt.sign(base, h.config.jwt.secret, { ...opts, audience: 'someone-else', algorithm: 'HS256' });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...base, sub: String(admin.id), iss: 'comms-stack', aud: 'comms-dashboard', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.`;
    for (const token of [tampered, wrongSecret, wrongAud, none, 'garbage']) {
      assert.equal((await h.agent().get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status, 401);
    }
  });

  test('refresh issues a new cookie; logout clears it and is audited', async () => {
    const login = await h.login('admin', h.config.adminPassword);
    const refresh = await h.agent().post('/api/auth/refresh').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(refresh.status, 200);
    assert.ok(refresh.headers['set-cookie'].some((c) => c.startsWith('session=') && /HttpOnly/i.test(c)));
    const out = await h.agent().post('/api/auth/logout').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(out.status, 200);
    assert.ok((await auditCount(h.db, "action = 'auth.logout'")) >= 1);
  });

  test('a session cannot be refreshed beyond its absolute maximum lifetime', async () => {
    const admin = await h.users.findAuthByUsername('admin');
    const old = jwt.sign({ tv: admin.token_version, st: Math.floor(Date.now() / 1000) - 13 * 3600 }, h.config.jwt.secret, {
      algorithm: 'HS256', subject: String(admin.id), issuer: 'comms-stack', audience: 'comms-dashboard', expiresIn: 600,
    });
    assert.equal((await h.agent().post('/api/auth/refresh').set('Authorization', `Bearer ${old}`)).status, 401);
  });

  test('cross-origin state-changing requests are rejected', async () => {
    const login = await h.login('admin', h.config.adminPassword);
    const res = await h.agent().post('/api/auth/refresh').set('Authorization', `Bearer ${login.body.token}`).set('Origin', 'https://evil.example').set('Host', 'communications.local');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'bad_origin');
  });

  test('oversized bodies are rejected with 413 and errors never leak stack traces', async () => {
    const big = await h.agent().post('/api/auth/login').send({ username: 'a', password: 'x'.repeat(20000) });
    assert.equal(big.status, 413);
    const malformed = await h.agent().post('/api/auth/login').set('Content-Type', 'application/json').send('{"username":');
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(JSON.stringify(malformed.body), /at .*\(.*\.js/);
  });
});

describe('login rate limiting', () => {
  let h;
  before(async () => {
    h = await createHarness({ env: { LOGIN_RATE_LIMIT_MAX: '3' } });
    await h.seedAdmin();
  });
  after(async () => h.cleanup());

  test('repeated failures are throttled with 429 and audited; other usernames are unaffected', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await h.login('admin', 'wrong-password-123')).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    assert.ok((await auditCount(h.db, "action = 'auth.login' AND details->>'reason' = 'rate_limited'")) >= 1);
    // The correct password for the throttled account is also refused while throttled...
    assert.equal((await h.login('admin', h.config.adminPassword)).status, 429);
    // ...but a different account is not locked out by someone else's failures.
    await h.users.create({ username: 'other.user', password: 'AnotherGoodPass-77', role: 'user', extension: null, is_active: true });
    assert.equal((await h.login('other.user', 'AnotherGoodPass-77')).status, 200);
  });
});
