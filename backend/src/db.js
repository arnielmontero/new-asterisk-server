'use strict';
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIGRATION_LOCK_ID = 727274;

class Database {
  constructor(dbConfig, logger) {
    this.logger = logger;
    this.pool = new Pool({ ...dbConfig, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    // An idle-client error (e.g. database restart) must not crash the process.
    this.pool.on('error', (err) => this.logger.error({ err: err.message }, 'database pool error'));
  }

  query(text, params) {
    return this.pool.query(text, params);
  }

  /** Run fn(client) inside a transaction. */
  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Wait for PostgreSQL, retrying with a fixed delay. */
  async connectWithRetry({ attempts = 30, delayMs = 2000 } = {}) {
    for (let i = 1; i <= attempts; i += 1) {
      try {
        await this.pool.query('SELECT 1');
        this.logger.info('database connected');
        return;
      } catch (err) {
        this.logger.warn({ attempt: i, attempts, err: err.message }, 'database not ready, retrying');
        if (i === attempts) throw new Error('database unavailable after retries');
        await sleep(delayMs);
      }
    }
  }

  async ping() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply pending migrations from a directory. Versioned by filename, checksummed,
   * serialized with an advisory lock, one transaction per migration.
   */
  async migrate(dir) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const applied = new Map(
        (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
      );
      for (const file of files) {
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const checksum = crypto.createHash('sha256').update(sql).digest('hex');
        if (applied.has(file)) {
          if (applied.get(file) !== checksum) {
            throw new Error(`migration ${file} was modified after being applied`);
          }
          continue;
        }
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
          await client.query('COMMIT');
          this.logger.info({ migration: file }, 'migration applied');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw new Error(`migration ${file} failed: ${err.message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { Database };
