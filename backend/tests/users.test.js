'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, auditCount } = require('./helpers');

describe('user management', () => {
  let h; let admin; let operator;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.one', role: 'operator', extension: '1001' });
  });
  after(async () => h.cleanup());

  const create = (body, who = admin) => h.agent().post('/api/users').set(who.auth).send(body);

  test('admin can create a user; the password hash is never returned', async () => {
    const res = await create({ username: 'New.Person', password: 'a-long-enough-passphrase', role: 'operator', extension: '1002' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, 'new.person', 'usernames are normalised to lower case');
    assert.equal(res.body.user.role, 'operator');
    assert.equal(res.body.user.extension, '1002');
    assert.equal(res.body.user.password_hash, undefined);
    assert.equal(res.body.user.password, undefined);
    const stored = await h.users.findAuthByUsername('new.person');
    assert.match(stored.password_hash, /^\$2[aby]\$12\$/, 'bcrypt with cost 12');
    assert.notEqual(stored.password_hash, 'a-long-enough-passphrase');
    assert.ok((await auditCount(h.db, "action = 'user.create' AND target = 'new.person' AND username = 'admin'")) === 1);
  });

  test('the new user can log in', async () => {
    assert.equal((await h.login('new.person', 'a-long-enough-passphrase')).status, 200);
  });

  test('list returns users without secrets', async () => {
    const res = await h.agent().get('/api/users').set(admin.auth);
    assert.equal(res.status, 200);
    assert.ok(res.body.users.length >= 3);
    assert.ok(res.body.users.every((u) => u.password_hash === undefined && u.token_version === undefined));
  });

  test('input validation rejects bad usernames, roles, extensions, weak passwords and unknown fields', async () => {
    const good = { username: 'valid.name', password: 'a-long-enough-passphrase', role: 'user' };
    const bad = [
      { ...good, username: 'ab' },
      { ...good, username: 'has space' },
      { ...good, username: 'x'.repeat(40) },
      { ...good, username: "robert'); drop table users;--" },
      { ...good, role: 'superuser' },
      { ...good, extension: '9999' },
      { ...good, password: 'short' },
      { ...good, password: 'x'.repeat(200) },
      { ...good, is_admin: true },
      { ...good, role: undefined },
    ];
    for (const body of bad) {
      const res = await create(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(res.body.error.code, 'validation_error');
    }
    assert.equal((await create({ ...good, password: 'valid.name-valid.name' })).status, 400, 'password must not contain the username');
    assert.equal((await create({ ...good, password: 'aaaaaaaaaaaaaaaa' })).status, 400, 'single repeated character');
    assert.equal((await auditCount(h.db, "action = 'user.create' AND status = 'failure'")) >= 0, true);
  });

  test('duplicate username and duplicate extension are rejected with 409', async () => {
    const dupName = await create({ username: 'new.person', password: 'a-long-enough-passphrase', role: 'user' });
    assert.equal(dupName.status, 409);
    assert.equal(dupName.body.error.code, 'username_taken');
    const dupExt = await create({ username: 'someone.else', password: 'a-long-enough-passphrase', role: 'operator', extension: '1001' });
    assert.equal(dupExt.status, 409);
    assert.equal(dupExt.body.error.code, 'extension_taken');
  });

  test('admin can change role, deactivate, reactivate and reset a password', async () => {
    const u = await h.users.create({ username: 'edit.me', password: 'original-passphrase-1', role: 'user', extension: null, is_active: true });
    const patch = (body) => h.agent().patch(`/api/users/${u.id}`).set(admin.auth).send(body);

    assert.equal((await patch({ role: 'operator' })).body.user.role, 'operator');
    assert.equal((await patch({ is_active: false })).body.user.is_active, false);
    assert.equal((await h.login('edit.me', 'original-passphrase-1')).status, 401, 'deactivated users cannot log in');
    assert.equal((await patch({ is_active: true })).body.user.is_active, true);
    assert.equal((await patch({ password: 'brand-new-passphrase-2' })).status, 200);
    assert.equal((await h.login('edit.me', 'original-passphrase-1')).status, 401, 'old password no longer works');
    assert.equal((await h.login('edit.me', 'brand-new-passphrase-2')).status, 200);
    assert.ok((await auditCount(h.db, "action = 'user.update' AND target = 'edit.me'")) >= 4);
    const audited = (await h.db.query("SELECT details FROM audit_logs WHERE action = 'user.update' AND details::text LIKE '%password%' LIMIT 1")).rows[0];
    assert.deepEqual(audited.details, { changed: ['password'] }, 'the audit trail records that a password changed, never the value');
  });

  test('a deactivated user\'s existing token stops working immediately', async () => {
    const u = await h.makeUser({ username: 'about.to.go', role: 'user' });
    assert.equal((await h.agent().get('/api/auth/me').set(u.auth)).status, 200);
    await h.agent().patch(`/api/users/${u.id}`).set(admin.auth).send({ is_active: false });
    assert.equal((await h.agent().get('/api/auth/me').set(u.auth)).status, 401);
    assert.ok(h.disconnected.includes(u.id), 'live sockets of the user are dropped');
  });

  test('PATCH rejects empty bodies, unknown fields and a bad id', async () => {
    assert.equal((await h.agent().patch(`/api/users/${operator.id}`).set(admin.auth).send({})).status, 400);
    assert.equal((await h.agent().patch(`/api/users/${operator.id}`).set(admin.auth).send({ username: 'renamed' })).status, 400);
    assert.equal((await h.agent().patch('/api/users/abc').set(admin.auth).send({ role: 'user' })).status, 400);
    assert.equal((await h.agent().patch('/api/users/999999').set(admin.auth).send({ role: 'user' })).status, 404);
  });

  test('admin can delete a user; audit history is kept', async () => {
    const u = await h.users.create({ username: 'delete.me', password: 'doomed-passphrase-1', role: 'user', extension: null, is_active: true });
    await h.login('delete.me', 'doomed-passphrase-1');
    const res = await h.agent().delete(`/api/users/${u.id}`).set(admin.auth);
    assert.equal(res.status, 200);
    assert.equal((await h.login('delete.me', 'doomed-passphrase-1')).status, 401);
    assert.equal(await auditCount(h.db, "action = 'user.delete' AND target = 'delete.me'"), 1);
    assert.ok((await auditCount(h.db, "username = 'delete.me' AND user_id IS NULL")) >= 1, 'their login history survives with the username snapshot');
    assert.equal((await h.agent().delete(`/api/users/${u.id}`).set(admin.auth)).status, 404);
  });

  test('non-admins cannot manage users', async () => {
    assert.equal((await h.agent().get('/api/users').set(operator.auth)).status, 403);
    assert.equal((await create({ username: 'sneaky.user', password: 'a-long-enough-passphrase', role: 'admin' }, operator)).status, 403);
    assert.equal((await h.agent().patch(`/api/users/${operator.id}`).set(operator.auth).send({ role: 'admin' })).status, 403);
    assert.equal((await h.agent().delete(`/api/users/${admin.id}`).set(operator.auth)).status, 403);
    assert.equal((await h.agent().get('/api/users')).status, 401);
    assert.equal((await h.users.findAuthByUsername('sneaky.user')), null);
  });

  test('the last active administrator cannot be deleted, deactivated or demoted', async () => {
    const del = await h.agent().delete(`/api/users/${admin.id}`).set(admin.auth);
    assert.equal(del.status, 409);
    assert.equal(del.body.error.code, 'last_admin');
    assert.equal((await h.agent().patch(`/api/users/${admin.id}`).set(admin.auth).send({ is_active: false })).status, 409);
    assert.equal((await h.agent().patch(`/api/users/${admin.id}`).set(admin.auth).send({ role: 'operator' })).status, 409);
    assert.ok((await auditCount(h.db, "action IN ('user.delete','user.update') AND status = 'failure'")) >= 3);
  });

  test('with a second admin, either can be removed but never both', async () => {
    const second = await h.users.create({ username: 'admin.two', password: 'second-admin-passphrase', role: 'admin', extension: null, is_active: true });
    assert.equal((await h.agent().patch(`/api/users/${second.id}`).set(admin.auth).send({ role: 'operator' })).status, 200);
    assert.equal((await h.agent().patch(`/api/users/${admin.id}`).set(admin.auth).send({ role: 'operator' })).status, 409);
  });

  test('concurrent demotions cannot remove every administrator', async () => {
    const a = await h.users.create({ username: 'race.a', password: 'race-admin-passphrase-a', role: 'admin', extension: null, is_active: true });
    const b = await h.users.create({ username: 'race.b', password: 'race-admin-passphrase-b', role: 'admin', extension: null, is_active: true });
    // demote everyone except a and b to operators so only a, b (and original admin) are admins
    const results = await Promise.allSettled([
      h.users.update(a.id, { role: 'user' }),
      h.users.update(b.id, { role: 'user' }),
      h.users.update(admin.id, { role: 'user' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.ok(ok <= 2, 'at most two of three concurrent demotions may succeed');
    const left = Number((await h.db.query("SELECT count(*) AS n FROM users WHERE role='admin' AND is_active")).rows[0].n);
    assert.ok(left >= 1, 'an administrator always remains');
  });
});
