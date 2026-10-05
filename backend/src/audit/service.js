'use strict';

class AuditService {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Append an audit record. Failures are logged loudly but never thrown: losing
   * an audit row must not turn a successful telephony action into an error.
   */
  async log({ user, username, action, target = null, ip = null, status = 'success', details = null }) {
    const insert = (userId) =>
      this.db.query(
        `INSERT INTO audit_logs (user_id, username, action, target, ip_address, status, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          username ?? user?.username ?? null,
          action,
          target,
          ip,
          status,
          details ? JSON.stringify(details) : null,
        ],
      );
    try {
      await insert(user?.id ?? null);
    } catch (err) {
      if (err.code === '23503' && user?.id) {
        // The user was deleted while this event was in flight: keep the record, keep the username snapshot.
        try {
          await insert(null);
          return;
        } catch (retryErr) {
          this.logger.error({ err: retryErr.message, action }, 'FAILED TO WRITE AUDIT RECORD');
          return;
        }
      }
      this.logger.error({ err: err.message, action }, 'FAILED TO WRITE AUDIT RECORD');
    }
  }

  async list({ page, pageSize, action, username, status, from, to }) {
    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (action) add('action = ?', action);
    if (username) add('username = ?', username.toLowerCase());
    if (status) add('status = ?', status);
    if (from) add('"timestamp" >= ?', from);
    if (to) add('"timestamp" <= ?', to);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = Number(
      (await this.db.query(`SELECT count(*) AS n FROM audit_logs ${clause}`, params)).rows[0].n,
    );
    const limitIdx = params.length + 1;
    const rows = (
      await this.db.query(
        `SELECT id, "timestamp", username, action, target, ip_address, status, details
         FROM audit_logs ${clause}
         ORDER BY "timestamp" DESC, id DESC
         LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
        [...params, pageSize, (page - 1) * pageSize],
      )
    ).rows;
    return { total, page, pageSize, items: rows };
  }
}

module.exports = { AuditService };
