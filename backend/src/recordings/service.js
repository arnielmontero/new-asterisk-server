'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { notFound } = require('../errors');
const { wavInfo } = require('../media/wavinfo');

const FILE_RE = /^[A-Za-z0-9._-]+\.wav$/;
const MIN_SECONDS = 1; // a call that was bridged for less than this is not worth keeping (the file is only a header)

const publicRecording = (r) => ({
  id: Number(r.id),
  started_at: r.started_at,
  duration_secs: r.duration_secs,
  size_bytes: Number(r.size_bytes),
  src: r.src || null,
  dst: r.dst || null,
  direction: r.direction || null,
  trunk: r.trunk || null,
});

/**
 * Call recordings. The dialplan starts MixMonitor and reports the file (RecordingStarted UserEvent). The recording
 * ends when the channel that runs it hangs up (the Hangup event; Asterisk does not reliably send MixMonitorStop for
 * that), after which the file is measured, once it has stopped growing, and listed. Who talked to whom comes from the call history,
 * joined through the call's linked id.
 */
class RecordingService {
  constructor({ db, ami, logger, dir }) {
    this.db = db;
    this.logger = logger;
    this.dir = dir;
    this.onChange = null;
    this.settleMs = 400; // how long the file must stay the same size before it is considered complete
    this.endDelayMs = 1000; // Asterisk closes the file shortly after the channel hangs up
    this.active = new Set(); // unique ids of recordings that have started and not been finished
    ami.on('event', (evt) => {
      const run = (p) => p.catch((err) => logger.error({ err: err.message, event: evt.Event }, 'recording event failed'));
      if (evt.Event === 'UserEvent' && evt.UserEvent === 'RecordingStarted') run(this.started(evt));
      else if ((evt.Event === 'Hangup' || evt.Event === 'MixMonitorStop') && this.active.has(evt.Uniqueid)) {
        const uid = evt.Uniqueid;
        this.active.delete(uid);
        setTimeout(() => run(this.finish(uid)), this.endDelayMs).unref?.();
      }
    });
  }

  /** Recordings that were running when the backend last stopped are picked up again. */
  async init() {
    const { rows } = await this.db.query('SELECT unique_id FROM recordings WHERE NOT finished');
    for (const r of rows) this.active.add(r.unique_id);
  }

  file(name) { return path.join(this.dir, name); }

  async started(evt) {
    const file = String(evt.File || '');
    const uniqueId = String(evt.Uniqueid || '');
    if (!FILE_RE.test(file) || !/^[A-Za-z0-9._-]{1,64}$/.test(uniqueId) || file !== `${uniqueId}.wav`) return null;
    const linked = /^[A-Za-z0-9._-]{1,64}$/.test(evt.Linkedid || '') ? evt.Linkedid : uniqueId;
    const res = await this.db.query(
      'INSERT INTO recordings (unique_id, file, linked_id) VALUES ($1,$2,$3) ON CONFLICT (unique_id) DO NOTHING RETURNING id',
      [uniqueId, file, linked],
    );
    if (res.rows[0]?.id) this.active.add(uniqueId);
    return res.rows[0]?.id ? Number(res.rows[0].id) : null;
  }

  /** The channel stopped recording: measure the file; drop it if the call never got as far as a conversation. */
  async finish(uniqueId) {
    const r = (await this.db.query('SELECT id, file FROM recordings WHERE unique_id = $1 AND NOT finished', [uniqueId])).rows[0];
    if (!r) return null;
    this.active.delete(uniqueId);
    let info = await wavInfo(this.file(r.file));
    // Asterisk may still be writing the last frames: wait until the size stops changing.
    for (let i = 0; info && this.settleMs > 0 && i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      const again = await wavInfo(this.file(r.file));
      if (!again || again.bytes === info.bytes) { info = again || info; break; }
      info = again;
    }
    if (!info || info.durationSecs < MIN_SECONDS) {
      await this.db.query('DELETE FROM recordings WHERE id = $1', [r.id]);
      await fsp.unlink(this.file(r.file)).catch(() => {});
      return null;
    }
    await this.db.query('UPDATE recordings SET finished = TRUE, size_bytes = $2, duration_secs = $3 WHERE id = $1', [r.id, info.bytes, Math.round(info.durationSecs)]);
    this.onChange?.({ kind: 'new', id: Number(r.id) });
    return Number(r.id);
  }

  /** Recordings whose end was never reported (the backend or Asterisk restarted mid-call) are closed from the file itself. */
  async sweep(olderThanMinutes = 180) {
    const { rows } = await this.db.query(
      `SELECT unique_id FROM recordings WHERE NOT finished AND started_at < now() - ($1::int * interval '1 minute')`, [olderThanMinutes]);
    for (const r of rows) await this.finish(r.unique_id);
    return rows.length;
  }

  where(f) {
    const w = ['r.finished'];
    const p = [];
    if (f.from) { p.push(f.from); w.push(`r.started_at >= $${p.length}`); }
    if (f.to) { p.push(f.to); w.push(`r.started_at <= $${p.length}`); }
    if (f.number) { p.push(`%${f.number}%`); w.push(`(c.src ILIKE $${p.length} OR c.dst ILIKE $${p.length})`); }
    return { clause: `WHERE ${w.join(' AND ')}`, params: p };
  }

  async list(f) {
    const { clause, params } = this.where(f);
    const from = `FROM recordings r
      LEFT JOIN LATERAL (SELECT src, dst, direction, trunk FROM cdr
                         WHERE cdr.linked_id = r.linked_id OR cdr.unique_id = r.linked_id
                         ORDER BY (disposition = 'ANSWERED') DESC, billsec DESC LIMIT 1) c ON TRUE`;
    const total = Number((await this.db.query(`SELECT count(*) AS n ${from} ${clause}`, params)).rows[0].n);
    const n = params.length;
    const { rows } = await this.db.query(
      `SELECT r.id, r.started_at, r.duration_secs, r.size_bytes, c.src, c.dst, c.direction, c.trunk ${from} ${clause}
       ORDER BY r.started_at DESC, r.id DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    );
    return { total, page: f.page, pageSize: f.pageSize, items: rows.map(publicRecording) };
  }

  async get(id) {
    const r = (await this.db.query('SELECT * FROM recordings WHERE id = $1 AND finished', [id])).rows[0];
    if (!r) throw notFound('Recording not found');
    return { ...publicRecording(r), file: r.file };
  }

  async remove(id) {
    const r = (await this.db.query('DELETE FROM recordings WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!r) throw notFound('Recording not found');
    await fsp.unlink(this.file(r.file)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    return publicRecording(r);
  }

  /** Retention: delete recordings older than `days`. Returns the number removed. */
  async prune(days) {
    const { rows } = await this.db.query(`DELETE FROM recordings WHERE started_at < now() - ($1::int * interval '1 day') RETURNING file`, [days]);
    for (const r of rows) await fsp.unlink(this.file(r.file)).catch(() => {});
    return rows.length;
  }
}

module.exports = { RecordingService };
