'use strict';

// AMI QueueMember "Status" values (Asterisk device states).
const MEMBER_STATE = { 1: 'available', 2: 'on call', 3: 'busy', 4: 'invalid', 5: 'unavailable', 6: 'ringing', 7: 'ringing', 8: 'on hold' };
const FAILED_OUTCOME = { TIMEOUT: 'timeout', FULL: 'full', JOINEMPTY: 'unavailable', LEAVEEMPTY: 'unavailable', JOINUNAVAIL: 'unavailable', LEAVEUNAVAIL: 'unavailable' };

const queueNumber = (name) => { const m = /^q-(\d{3,6})$/.exec(String(name || '')); return m ? m[1] : null; };
const memberExtension = (iface) => { const m = /^Local\/(\d{3,6})@queue-member/.exec(String(iface || '')); return m ? m[1] : null; };
const toInt = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/**
 * Live queue state and statistics, from real Asterisk data:
 *  - status():  QueueStatus (callers waiting, each agent's state, paused or not)
 *  - pause():   QueuePause (an agent stops receiving queue calls without leaving the queue)
 *  - events:    AgentComplete / QueueCallerAbandon / the dialplan's QueueFailed UserEvent become rows in queue_calls,
 *               from which the statistics (served, abandoned, waits, service level, per agent) are computed.
 */
class QueueService {
  constructor({ ami, db, logger }) {
    this.ami = ami;
    this.db = db;
    this.logger = logger;
    this.onRecord = null;
    ami.on('event', (evt) => {
      this.ingest(evt).catch((err) => logger.error({ err: err.message, event: evt.Event }, 'queue event failed'));
    });
  }

  /**
   * Store one finished queue call. Asterisk reports a caller who times out as an abandon *and* our dialplan reports the
   * real reason (QueueFailed) a moment later, so "failed" events (override) replace an earlier "abandoned" row.
   */
  async record({ queue, uniqueId, caller, agent, wait, talk, outcome, override = false }) {
    if (!queue || !uniqueId) return null;
    const res = await this.db.query(
      `INSERT INTO queue_calls (queue, unique_id, caller, agent, wait_secs, talk_secs, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (unique_id, queue) DO ${override ? "UPDATE SET outcome = EXCLUDED.outcome WHERE queue_calls.outcome = 'abandoned'" : "NOTHING"} RETURNING id`,
      [queue, uniqueId, caller || null, agent || null, wait, talk, outcome],
    );
    const id = res.rows[0]?.id ?? null;
    if (id) this.onRecord?.({ queue, outcome });
    return id;
  }

  async ingest(evt) {
    switch (evt.Event) {
      case 'AgentComplete':
        return this.record({
          queue: queueNumber(evt.Queue), uniqueId: evt.Uniqueid, caller: evt.CallerIDNum, agent: memberExtension(evt.Interface),
          wait: toInt(evt.HoldTime), talk: toInt(evt.TalkTime), outcome: 'answered',
        });
      case 'QueueCallerAbandon':
        return this.record({ queue: queueNumber(evt.Queue), uniqueId: evt.Uniqueid, caller: evt.CallerIDNum, wait: toInt(evt.HoldTime), talk: 0, outcome: 'abandoned' });
      case 'UserEvent':
        if (evt.UserEvent !== 'QueueFailed') return null;
        return this.record({
          queue: /^\d{3,6}$/.test(evt.Queue || '') ? evt.Queue : null, uniqueId: evt.Uniqueid, caller: evt.Caller,
          wait: 0, talk: 0, outcome: FAILED_OUTCOME[evt.Status] || 'unavailable', override: true,
        });
      default:
        return null;
    }
  }

  /** Waiting callers and agent states for every queue Asterisk knows. */
  async status() {
    if (!this.ami.isConnected()) return { available: false, queues: [] };
    const res = await this.ami.action({ Action: 'QueueStatus' });
    const queues = new Map();
    const get = (name) => {
      const number = queueNumber(name);
      if (!number) return null;
      if (!queues.has(number)) queues.set(number, { number, calls: 0, holdtime: 0, completed: 0, abandoned: 0, members: [], callers: [] });
      return queues.get(number);
    };
    for (const e of res.events || []) {
      const q = get(e.Queue);
      if (!q) continue;
      if (e.Event === 'QueueParams') {
        Object.assign(q, { calls: toInt(e.Calls), holdtime: toInt(e.Holdtime), completed: toInt(e.Completed), abandoned: toInt(e.Abandoned) });
      } else if (e.Event === 'QueueMember') {
        const extension = memberExtension(e.Location);
        if (extension) {
          q.members.push({
            extension, state: MEMBER_STATE[toInt(e.Status)] || 'unknown', paused: e.Paused === '1', pausedReason: e.PausedReason || '',
            callsTaken: toInt(e.CallsTaken), inCall: e.InCall === '1', lastCall: toInt(e.LastCall),
          });
        }
      } else if (e.Event === 'QueueEntry') {
        q.callers.push({ position: toInt(e.Position), caller: e.CallerIDNum || '', name: e.CallerIDName || '', waitSecs: toInt(e.Wait) });
      }
    }
    return { available: true, queues: [...queues.values()] };
  }

  /** Pause or resume an extension in one queue (or, with no queue, in all of them). */
  async pause(extension, paused, queue = null) {
    const fields = { Action: 'QueuePause', Interface: `Local/${extension}@queue-member/n`, Paused: paused ? 'true' : 'false', Reason: 'dashboard' };
    if (queue) fields.Queue = `q-${queue}`;
    const res = await this.ami.action(fields);
    if (res.response !== 'Success') throw new Error(res.message || 'Asterisk refused the request');
  }

  /** Statistics per queue and per agent for a period; the service level is the share answered within `serviceLevel` seconds. */
  async stats({ from, to, serviceLevel = 20, queue = null }) {
    const params = [serviceLevel];
    const where = [];
    if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); where.push(`created_at <= $${params.length}`); }
    if (queue) { params.push(queue); where.push(`queue = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const per = (await this.db.query(
      `SELECT queue, count(*) AS offered,
              count(*) FILTER (WHERE outcome = 'answered') AS answered,
              count(*) FILTER (WHERE outcome = 'abandoned') AS abandoned,
              count(*) FILTER (WHERE outcome IN ('timeout', 'unavailable', 'full')) AS unserved,
              COALESCE(round(avg(wait_secs) FILTER (WHERE outcome = 'answered')), 0) AS avg_wait,
              COALESCE(round(avg(talk_secs) FILTER (WHERE outcome = 'answered')), 0) AS avg_talk,
              COALESCE(max(wait_secs), 0) AS longest_wait,
              count(*) FILTER (WHERE outcome = 'answered' AND wait_secs <= $1) AS answered_in_level
       FROM queue_calls ${clause} GROUP BY queue ORDER BY queue`, params)).rows;
    const agents = (await this.db.query(
      `SELECT queue, agent, count(*) AS calls, COALESCE(sum(talk_secs), 0) AS talk_secs, COALESCE(round(avg(wait_secs)), 0) AS avg_wait
       FROM queue_calls ${clause ? `${clause} AND` : 'WHERE'} $1::int > 0 AND outcome = 'answered' AND agent IS NOT NULL GROUP BY queue, agent ORDER BY queue, calls DESC`,
      params)).rows;
    const num = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /^-?\d+$/.test(String(v)) && k !== 'queue' && k !== 'agent' ? Number(v) : v]));
    return {
      serviceLevelSecs: serviceLevel,
      queues: per.map(num).map((r) => ({ ...r, service_level: r.offered ? Math.round((r.answered_in_level / r.offered) * 100) : null })),
      agents: agents.map(num),
    };
  }
}

module.exports = { QueueService, queueNumber, memberExtension };
