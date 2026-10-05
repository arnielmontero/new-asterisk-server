'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness, MIGRATIONS, auditCount } = require('./helpers');
const { Database } = require('../src/db');
const { createLogger } = require('../src/logger');

describe('database', () => {
  let h;
  before(async () => {
    h = await createHarness();
  });
  after(async () => h.cleanup());

  const reject = async (sql, params, code) => {
    await assert.rejects(h.db.query(sql, params), (err) => {
      assert.equal(err.code, code, `${sql} -> ${err.code} ${err.message}`);
      return true;
    });
  };
  const hash = '$2a$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz0123456';

  test('migrations apply on a fresh database and are recorded with checksums', async () => {
    const { rows } = await h.db.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].name, '001_init.sql');
    assert.match(rows[0].checksum, /^[0-9a-f]{64}$/);
    for (const t of ['users', 'audit_logs']) {
      const r = await h.db.query('SELECT to_regclass($1) AS t', [t]);
      assert.ok(r.rows[0].t, `${t} exists`);
    }
  });

  test('migrations are repeat-safe: re-running changes nothing and keeps data (existing database / restart)', async () => {
    await h.users.create({ username: 'keeps.data', password: 'persistent-passphrase-1', role: 'user', extension: null, is_active: true });
    const before = (await h.db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n;
    await h.db.migrate(MIGRATIONS);
    await h.db.migrate(MIGRATIONS);
    assert.equal((await h.db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n, before);
    assert.ok(await h.users.findAuthByUsername('keeps.data'));
  });

  test('concurrent startups cannot corrupt migrations (advisory lock)', async () => {
    const fresh = await createHarness({ migrate: false });
    try {
      const results = await Promise.allSettled([fresh.db.migrate(MIGRATIONS), fresh.db.migrate(MIGRATIONS), fresh.db.migrate(MIGRATIONS)]);
      assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => r.reason?.message)));
      assert.equal((await fresh.db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n, '1');
    } finally {
      await fresh.cleanup();
    }
  });

  test('a migration edited after being applied is detected and refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.copyFileSync(path.join(MIGRATIONS, '001_init.sql'), path.join(dir, '001_init.sql'));
    fs.appendFileSync(path.join(dir, '001_init.sql'), '\n-- tampered\n');
    await assert.rejects(h.db.migrate(dir), /modified after being applied/);
  });

  test('a failing migration rolls back completely', async () => {
    const fresh = await createHarness({ migrate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    fs.writeFileSync(path.join(dir, '001_bad.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;');
    try {
      await assert.rejects(fresh.db.migrate(dir), /001_bad.sql failed/);
      assert.equal((await fresh.db.query("SELECT to_regclass('half_done') AS t")).rows[0].t, null);
      assert.equal((await fresh.db.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n, '0');
    } finally {
      await fresh.cleanup();
    }
  });

  test('data persists across a connection pool restart', async () => {
    await h.users.create({ username: 'survives.restart', password: 'persistent-passphrase-2', role: 'operator', extension: null, is_active: true });
    // A separate pool is opened, closed, and a brand-new one reads the same data back.
    const first = new Database(h.config.db, createLogger('silent'));
    await first.query('SELECT 1');
    await first.close();
    const reopened = new Database(h.config.db, createLogger('silent'));
    try {
      const { rows } = await reopened.query("SELECT username, role FROM users WHERE username = 'survives.restart'");
      assert.deepEqual(rows, [{ username: 'survives.restart', role: 'operator' }]);
    } finally {
      await reopened.close();
    }
  });

  test('constraints reject invalid users', async () => {
    const ins = 'INSERT INTO users (username, password_hash, role, extension) VALUES ($1, $2, $3, $4)';
    await reject(ins, ['bad.role', hash, 'superuser', null], '23514');
    await reject(ins, ['Upper.Case', hash, 'user', null], '23514');
    await reject(ins, ['ab', hash, 'user', null], '23514');
    await reject(ins, ['white space', hash, 'user', null], '23514');
    await reject(ins, ['bad.ext', hash, 'user', '2000'], '23514');
    await reject(ins, [null, hash, 'user', null], '23502');
    await reject(ins, ['no.hash', null, 'user', null], '23502');
  });

  test('constraints enforce unique usernames and one user per extension', async () => {
    const ins = 'INSERT INTO users (username, password_hash, role, extension) VALUES ($1, $2, $3, $4)';
    await h.db.query(ins, ['unique.one', hash, 'user', '1001']);
    await reject(ins, ['unique.one', hash, 'user', null], '23505');
    await reject(ins, ['unique.two', hash, 'operator', '1001'], '23505');
    await h.db.query(ins, ['unique.two', hash, 'operator', null]);
    await h.db.query(ins, ['unique.three', hash, 'operator', null]); // NULL extensions may repeat
  });

  test('audit_logs has constraints, indexes and foreign key', async () => {
    await reject("INSERT INTO audit_logs (action, status) VALUES ('x', 'maybe')", [], '23514');
    await reject("INSERT INTO audit_logs (action, status) VALUES (NULL, 'success')", [], '23502');
    await reject("INSERT INTO audit_logs (action, status, user_id) VALUES ('x', 'success', 987654321)", [], '23503');
    const { rows } = await h.db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'audit_logs'");
    const names = rows.map((r) => r.indexname);
    for (const idx of ['audit_logs_timestamp_idx', 'audit_logs_username_idx', 'audit_logs_action_idx']) assert.ok(names.includes(idx), idx);
  });

  test('audit records are append-only: UPDATE, DELETE and TRUNCATE are rejected by the database itself', async () => {
    await h.audit.log({ username: 'someone', action: 'test.event', target: 't', ip: '10.0.0.1' });
    assert.equal(await auditCount(h.db, "action = 'test.event'"), 1);
    await assert.rejects(h.db.query("UPDATE audit_logs SET action = 'tampered' WHERE action = 'test.event'"), /append-only/);
    await assert.rejects(h.db.query("UPDATE audit_logs SET status = 'failure' WHERE action = 'test.event'"), /append-only/);
    await assert.rejects(h.db.query("DELETE FROM audit_logs WHERE action = 'test.event'"), /append-only/);
    await assert.rejects(h.db.query('TRUNCATE audit_logs'), /append-only/);
    assert.equal(await auditCount(h.db, "action = 'test.event'"), 1);
  });

  test('deleting a user keeps their audit rows (user_id nulled, username kept)', async () => {
    const u = await h.users.create({ username: 'audited.user', password: 'audited-passphrase-1', role: 'user', extension: null, is_active: true });
    await h.audit.log({ user: u, action: 'test.owned' });
    assert.equal(await auditCount(h.db, 'user_id = $1', [u.id]), 1);
    await h.db.query('DELETE FROM users WHERE id = $1', [u.id]);
    assert.equal(await auditCount(h.db, "action = 'test.owned' AND user_id IS NULL AND username = 'audited.user'"), 1);
  });

  test('updated_at is maintained on user updates', async () => {
    const u = await h.users.create({ username: 'timestamped', password: 'timestamp-passphrase-1', role: 'user', extension: null, is_active: true });
    await new Promise((r) => setTimeout(r, 20));
    await h.users.update(u.id, { role: 'operator' });
    const after = await h.users.getPublicById(u.id);
    assert.ok(after.updated_at > u.updated_at);
    assert.ok(after.created_at.getTime() === u.created_at.getTime());
  });

  test('connectWithRetry gives up with a clear error when the database never appears', async () => {
    const lost = new Database({ ...h.config.db, port: 1, connectionTimeoutMillis: 200 }, createLogger('silent'));
    await assert.rejects(lost.connectWithRetry({ attempts: 2, delayMs: 10 }), /database unavailable after retries/);
    await lost.close().catch(() => {});
  });
});
