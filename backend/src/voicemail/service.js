'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { notFound } = require('../errors');
const { wavInfo } = require('../media/wavinfo');

const FILE_RE = /^(\d{3,6})-[A-Za-z0-9._-]+\.wav$/;
const MIN_SECONDS = 1; // anything shorter is a hang-up during the greeting or a stray noise, not a message

const publicMessage = (r) => ({
  id: Number(r.id),
  extension: r.extension,
  caller: r.caller,
  duration_secs: r.duration_secs,
  heard: !!r.heard_at,
  heard_at: r.heard_at,
  created_at: r.created_at,
});

/**
 * Voicemail messages. The dialplan records each message to /pbx-media/voicemail/<ext>-<uniqueid>.wav and reports it with
 * a VoicemailLeft UserEvent; this service checks the report against the disk and the database before listing it, so a
 * forged or stale event can never create a message for a file that is not there.
 */
class VoicemailService {
  constructor({ db, ami, logger, dir }) {
    this.db = db;
    this.logger = logger;
    this.dir = dir;
    this.onChange = null; // ({ extension, kind, id }) -> void, set by the socket layer
    ami.on('event', (evt) => {
      if (evt.Event === 'UserEvent' && evt.UserEvent === 'VoicemailLeft') {
        this.ingest(evt).catch((err) => logger.error({ err: err.message }, 'voicemail event failed'));
      }
    });
  }

  file(name) { return path.join(this.dir, name); }

  async ingest(evt) {
    const file = String(evt.File || '');
    const m = FILE_RE.exec(file);
    const extension = String(evt.Extension || '');
    if (!m || m[1] !== extension) return null;
    const box = (await this.db.query('SELECT 1 FROM extensions WHERE number = $1', [extension])).rows[0];
    if (!box) return null;
    const info = await wavInfo(this.file(file));
    if (!info) return null; // the caller left before anything was recorded
    if (info.durationSecs < MIN_SECONDS) {
      await fsp.unlink(this.file(file)).catch(() => {});
      return null;
    }
    const caller = /^[0-9A-Za-z+*#._@]{1,40}$/.test(evt.Caller || '') ? evt.Caller : null;
    const res = await this.db.query(
      'INSERT INTO voicemails (extension, caller, file, duration_secs) VALUES ($1,$2,$3,$4) ON CONFLICT (file) DO NOTHING RETURNING id',
      [extension, caller, file, Math.round(info.durationSecs)],
    );
    const id = res.rows[0]?.id ? Number(res.rows[0].id) : null;
    if (id) this.onChange?.({ extension, kind: 'new', id });
    return id;
  }

  async list({ extension = null, unread = false } = {}) {
    const where = [];
    const params = [];
    if (extension) { params.push(extension); where.push(`extension = $${params.length}`); }
    if (unread) where.push('heard_at IS NULL');
    const { rows } = await this.db.query(
      `SELECT * FROM voicemails ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT 500`, params,
    );
    return rows.map(publicMessage);
  }

  /** Unread message count per extension. */
  async unreadCounts() {
    const { rows } = await this.db.query('SELECT extension, count(*) AS n FROM voicemails WHERE heard_at IS NULL GROUP BY extension');
    return Object.fromEntries(rows.map((r) => [r.extension, Number(r.n)]));
  }

  async get(id) {
    const r = (await this.db.query('SELECT * FROM voicemails WHERE id = $1', [id])).rows[0];
    if (!r) throw notFound('Message not found');
    return { ...publicMessage(r), file: r.file };
  }

  async markHeard(id, heard) {
    const res = await this.db.query('UPDATE voicemails SET heard_at = CASE WHEN $2::boolean THEN COALESCE(heard_at, now()) ELSE NULL END WHERE id = $1 RETURNING *', [id, heard]);
    if (!res.rows[0]) throw notFound('Message not found');
    this.onChange?.({ extension: res.rows[0].extension, kind: 'heard', id });
    return publicMessage(res.rows[0]);
  }

  async remove(id) {
    const r = (await this.db.query('DELETE FROM voicemails WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!r) throw notFound('Message not found');
    await fsp.unlink(this.file(r.file)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    this.onChange?.({ extension: r.extension, kind: 'deleted', id });
    return publicMessage(r);
  }

  /** Retention: delete messages older than `days`. Returns the number removed. */
  async prune(days) {
    const { rows } = await this.db.query(`DELETE FROM voicemails WHERE created_at < now() - ($1::int * interval '1 day') RETURNING file`, [days]);
    for (const r of rows) await fsp.unlink(this.file(r.file)).catch(() => {});
    return rows.length;
  }
}

module.exports = { VoicemailService, FILE_RE };
