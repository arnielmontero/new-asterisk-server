'use strict';
const bcrypt = require('bcryptjs');
const { conflict, notFound, badRequest } = require('../errors');
const { passwordPolicyError } = require('../validation/schemas');

const BCRYPT_COST = 12;
const PUBLIC_COLUMNS = 'id, username, role, extension, is_active, created_at, updated_at';

// Valid bcrypt hash used to keep login timing similar for unknown usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

class UsersService {
  constructor(db) {
    this.db = db;
  }

  hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_COST);
  }

  async list() {
    return (await this.db.query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY username`)).rows;
  }

  async getPublicById(id) {
    const row = (await this.db.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id])).rows[0];
    if (!row) throw notFound('User not found');
    return row;
  }

  /** Full row for authentication; includes the hash and token_version. */
  async findAuthByUsername(username) {
    return (await this.db.query('SELECT * FROM users WHERE username = $1', [username])).rows[0] || null;
  }

  async findAuthById(id) {
    return (await this.db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] || null;
  }

  /** Constant-ish time credential check. Returns the user row or null. */
  async verifyCredentials(username, password) {
    const user = await this.findAuthByUsername(username);
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok || !user.is_active) return { user: null, reason: !user ? 'unknown_user' : !user.is_active ? 'inactive' : 'bad_password' };
    return { user, reason: null };
  }

  async create({ username, password, role, extension, is_active }) {
    const policy = passwordPolicyError(password, username);
    if (policy) throw badRequest(policy, 'weak_password');
    const hash = await this.hashPassword(password);
    try {
      const { rows } = await this.db.query(
        `INSERT INTO users (username, password_hash, role, extension, is_active)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_COLUMNS}`,
        [username, hash, role, extension, is_active],
      );
      return rows[0];
    } catch (err) {
      throw this.translate(err);
    }
  }

  /**
   * Update a user. Refuses any change that would leave the system without an
   * active administrator. Returns { user, changes } where changes lists the
   * fields that were modified (never including password values).
   */
  async update(id, patch) {
    if (patch.password) {
      const target = await this.findAuthById(id);
      if (!target) throw notFound('User not found');
      const policy = passwordPolicyError(patch.password, target.username);
      if (policy) throw badRequest(policy, 'weak_password');
    }
    const newHash = patch.password ? await this.hashPassword(patch.password) : null;

    try {
      return await this.db.tx(async (client) => {
        // Lock all administrators so concurrent updates cannot both pass the check.
        await client.query("SELECT id FROM users WHERE role = 'admin' FOR UPDATE");
        const current = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!current) throw notFound('User not found');

        const next = {
          role: patch.role ?? current.role,
          is_active: patch.is_active ?? current.is_active,
          extension: patch.extension === undefined ? current.extension : patch.extension,
        };
        await this.assertAdminRemains(client, current, next.role === 'admin' && next.is_active);

        const changes = [];
        const sets = [];
        const params = [];
        const set = (col, val) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if (next.role !== current.role) { set('role', next.role); changes.push('role'); }
        if (next.is_active !== current.is_active) { set('is_active', next.is_active); changes.push('is_active'); }
        if (next.extension !== current.extension) { set('extension', next.extension); changes.push('extension'); }
        if (newHash) { set('password_hash', newHash); changes.push('password'); }

        if (sets.length) {
          // Any security-relevant change invalidates sessions issued before it.
          if (changes.some((c) => c !== 'extension')) sets.push('token_version = token_version + 1');
          params.push(id);
          await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        }
        const user = (await client.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id])).rows[0];
        return { user, changes };
      });
    } catch (err) {
      throw this.translate(err);
    }
  }

  async remove(id) {
    return this.db.tx(async (client) => {
      await client.query("SELECT id FROM users WHERE role = 'admin' FOR UPDATE");
      const current = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!current) throw notFound('User not found');
      await this.assertAdminRemains(client, current, false);
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      return { id: current.id, username: current.username };
    });
  }

  /** Throw 409 if `current` is the last active admin and would stop being one. */
  async assertAdminRemains(client, current, remainsActiveAdmin) {
    const isActiveAdmin = current.role === 'admin' && current.is_active;
    if (!isActiveAdmin || remainsActiveAdmin) return;
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1",
      [current.id],
    );
    if (rows[0].n === 0) {
      throw conflict('This is the last active administrator and cannot be removed, disabled or demoted', 'last_admin');
    }
  }

  /** Create the initial administrator once; never overwrite an existing one. */
  async ensureAdmin(adminPassword) {
    const existing = await this.findAuthByUsername('admin');
    if (existing) return { created: false };
    const policy = passwordPolicyError(adminPassword, 'admin');
    if (policy || adminPassword.length < 12) {
      throw new Error('ADMIN_PASSWORD does not meet the password policy (at least 12 characters, not trivial)');
    }
    const hash = await this.hashPassword(adminPassword);
    const { rowCount } = await this.db.query(
      `INSERT INTO users (username, password_hash, role, extension)
       VALUES ('admin', $1, 'admin', NULL) ON CONFLICT (username) DO NOTHING`,
      [hash],
    );
    return { created: rowCount === 1 };
  }

  translate(err) {
    if (err && err.code === '23505') {
      if (String(err.constraint).includes('extension')) return conflict('That extension is already assigned to another user', 'extension_taken');
      return conflict('That username is already taken', 'username_taken');
    }
    return err;
  }
}

module.exports = { UsersService };
