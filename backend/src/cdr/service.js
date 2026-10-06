'use strict';

// The "calls" view: one row per call as a person would count it. Hidden: Local channel halves (click-to-call
// plumbing) and legs that were cancelled because another device of the same call answered.
const CALL_LEG_FILTER = `(COALESCE(channel, '') NOT LIKE 'Local/%'
  AND NOT (disposition <> 'ANSWERED' AND EXISTS (
    SELECT 1 FROM cdr c2 WHERE c2.unique_id = cdr.unique_id AND c2.id <> cdr.id AND c2.disposition = 'ANSWERED')))`;

// Asterisk writes CDR timestamps as "YYYY-MM-DD HH:MM:SS" in the container's local time (UTC).
function parseAstTime(value) {
  if (!value || !String(value).trim()) return null;
  const d = new Date(`${String(value).trim().replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Call detail records. Rows come from Asterisk's `Cdr` AMI event (cdr_manager), so they are real
 * records of calls the PBX handled, never synthesised. A call that rings several devices produces one
 * record per leg; the default "calls" view hides legs that never reached a destination channel.
 */
class CdrService {
  constructor({ db, registry, ami, logger }) {
    this.db = db;
    this.registry = registry;
    this.logger = logger;
    this.onRecord = null;
    ami.on('event', (evt) => {
      if (evt.Event === 'Cdr') this.ingest(evt).catch((err) => logger.error({ err: err.message }, 'CDR ingest failed'));
    });
  }

  direction(evt) {
    if (this.registry.trunkFromChannel(evt.Channel)) return { direction: 'inbound', trunk: this.registry.trunkFromChannel(evt.Channel) };
    const out = this.registry.trunkFromChannel(evt.DestinationChannel);
    if (out) return { direction: 'outbound', trunk: out };
    return { direction: 'internal', trunk: null };
  }

  async ingest(evt) {
    const start = parseAstTime(evt.StartTime);
    if (!start || !evt.UniqueID) return null;
    const { direction, trunk } = this.direction(evt);
    // Inbound trunk calls: the dialplan stored the number that was dialled; Asterisk's own destination is "h".
    const did = direction === 'inbound' && /^in:/.test(evt.UserField || '') ? evt.UserField.slice(3).split(':')[0] : null;
    const row = [
      evt.UniqueID, evt.LinkedID || null, start, parseAstTime(evt.AnswerTime), parseAstTime(evt.EndTime),
      evt.Source || null, did || evt.Destination || null, evt.CallerID || null, evt.Channel || null, evt.DestinationChannel || null,
      evt.LastApplication || null, evt.Disposition || null, Number(evt.Duration) || 0, Number(evt.BillableSeconds) || 0,
      direction, trunk, evt.UserField || null,
    ];
    const res = await this.db.query(
      `INSERT INTO cdr (unique_id, linked_id, start_time, answer_time, end_time, src, dst, caller_id, channel, dst_channel,
                        last_app, disposition, duration, billsec, direction, trunk, userfield)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING RETURNING id`,
      row,
    );
    const id = res.rows[0]?.id ?? null;
    if (id) this.onRecord?.({ id: Number(id), src: evt.Source, dst: evt.Destination, direction, disposition: evt.Disposition });
    return id;
  }

  where(f) {
    const w = [];
    const p = [];
    const add = (sql, v) => { p.push(v); w.push(sql.replace('?', `$${p.length}`)); };
    if (f.legs !== 'all') w.push(CALL_LEG_FILTER);
    if (f.from) add('start_time >= ?', f.from);
    if (f.to) add('start_time <= ?', f.to);
    if (f.number) { p.push(`%${f.number}%`); w.push(`(src ILIKE $${p.length} OR dst ILIKE $${p.length} OR caller_id ILIKE $${p.length})`); }
    if (f.src) add('src = ?', f.src);
    if (f.dst) add('dst = ?', f.dst);
    if (f.direction) add('direction = ?', f.direction);
    if (f.disposition) add('disposition = ?', f.disposition);
    if (f.trunk) add('trunk = ?', f.trunk);
    if (f.minDuration) add('billsec >= ?', f.minDuration);
    return { clause: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
  }

  async list(f) {
    const { clause, params } = this.where(f);
    const total = Number((await this.db.query(`SELECT count(*) AS n FROM cdr ${clause}`, params)).rows[0].n);
    const n = params.length;
    const rows = (await this.db.query(
      `SELECT id, unique_id, start_time, answer_time, end_time, src, dst, caller_id, channel, dst_channel, last_app,
              disposition, duration, billsec, direction, trunk
       FROM cdr ${clause} ORDER BY start_time DESC, id DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    )).rows;
    return { total, page: f.page, pageSize: f.pageSize, items: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  }

  async exportRows(f, limit = 50000) {
    const { clause, params } = this.where(f);
    return (await this.db.query(
      `SELECT start_time, answer_time, end_time, src, dst, caller_id, direction, trunk, disposition, duration, billsec, channel, dst_channel
       FROM cdr ${clause} ORDER BY start_time DESC, id DESC LIMIT ${Number(limit)}`,
      params,
    )).rows;
  }

  async stats({ from, to }) {
    const f = { legs: 'calls', from, to };
    const { clause, params } = this.where(f);
    const one = async (sql) => (await this.db.query(sql.replace('{W}', clause), params)).rows;
    const [summary] = await one(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE disposition = 'ANSWERED') AS answered,
              count(*) FILTER (WHERE disposition <> 'ANSWERED') AS missed,
              COALESCE(round(avg(billsec) FILTER (WHERE disposition = 'ANSWERED')), 0) AS avg_billsec,
              COALESCE(sum(billsec), 0) AS total_billsec
       FROM cdr {W}`,
    );
    const byDirection = await one(`SELECT direction, count(*) AS calls, COALESCE(sum(billsec),0) AS billsec FROM cdr {W} GROUP BY direction ORDER BY direction`);
    const byDisposition = await one(`SELECT disposition, count(*) AS calls FROM cdr {W} GROUP BY disposition ORDER BY calls DESC`);
    const perDay = await one(
      `SELECT to_char(date_trunc('day', start_time), 'YYYY-MM-DD') AS day, count(*) AS calls,
              count(*) FILTER (WHERE disposition = 'ANSWERED') AS answered
       FROM cdr {W} GROUP BY 1 ORDER BY 1 DESC LIMIT 31`,
    );
    const perHour = await one(`SELECT extract(hour FROM start_time)::int AS hour, count(*) AS calls FROM cdr {W} GROUP BY 1 ORDER BY 1`);
    const topSources = await one(`SELECT src AS number, count(*) AS calls FROM cdr {W} GROUP BY src ORDER BY calls DESC LIMIT 10`);
    const topDestinations = await one(`SELECT dst AS number, count(*) AS calls FROM cdr {W} GROUP BY dst ORDER BY calls DESC LIMIT 10`);
    const num = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /^-?\d+$/.test(String(v)) ? Number(v) : v]));
    return {
      summary: num(summary),
      byDirection: byDirection.map(num),
      byDisposition: byDisposition.map(num),
      perDay: perDay.map(num).reverse(),
      perHour: perHour.map(num),
      topSources: topSources.map(num),
      topDestinations: topDestinations.map(num),
    };
  }

  /** Retention: delete records older than `days`. Returns the number removed. */
  async prune(days) {
    const res = await this.db.query(`DELETE FROM cdr WHERE start_time < now() - ($1::int * interval '1 day')`, [days]);
    return res.rowCount;
  }
}

module.exports = { CdrService, parseAstTime, CALL_LEG_FILTER };
