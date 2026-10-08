'use strict';
const { z } = require('zod');
const { badRequest } = require('../errors');

// A destination is where a call goes next: { type, value }. Every feature that can route a call (inbound
// routes, trunk defaults, ring group fallbacks, time conditions, forwarding ...) uses this one shape, so a
// new kind of destination only has to be added here and in the renderer.
const DEST_TYPES = ['extension', 'ringgroup', 'timecondition', 'ivr', 'announcement', 'queue', 'voicemail', 'conference', 'echo', 'hangup'];
const HANGUP_REASONS = ['', 'busy', 'congestion', 'reject'];

const destinationSchema = z.strictObject({
  type: z.enum(DEST_TYPES),
  value: z.string().trim().max(40).optional().default(''),
});

const NUMBER_TYPES = new Set(['extension', 'ringgroup', 'ivr', 'queue', 'voicemail', 'conference']);
const ID_TYPES = new Set(['timecondition', 'announcement']);

/** Name of the dialplan context that handles a destination. Every destination type has one (rendered). */
function dstContext(dest) {
  if (!dest) return 'dst-hangup-reject';
  if (dest.type === 'echo') return 'dst-echo-0';
  if (dest.type === 'hangup') return `dst-hangup-${dest.value || 'reject'}`;
  return `dst-${dest.type}-${dest.value}`;
}

const label = (dest) => {
  if (!dest) return 'hang up';
  switch (dest.type) {
    case 'extension': return `extension ${dest.value}`;
    case 'ringgroup': return `ring group ${dest.value}`;
    case 'timecondition': return `time condition ${dest.value}`;
    case 'ivr': return `menu ${dest.value}`;
    case 'queue': return `queue ${dest.value}`;
    case 'conference': return `conference room ${dest.value}`;
    case 'voicemail': return `voicemail of ${dest.value}`;
    case 'announcement': return `announcement ${dest.value}`;
    case 'echo': return 'echo test';
    default: return 'reject';
  }
};

/** Throws a 400 unless the destination is well formed and points at something that exists. */
async function assertValid(db, dest) {
  if (!dest) return;
  const bad = (msg) => badRequest(msg, 'bad_destination');
  if (NUMBER_TYPES.has(dest.type) && !/^[0-9]{3,6}$/.test(dest.value)) throw bad(`A ${dest.type} destination needs a number`);
  if (ID_TYPES.has(dest.type) && !/^[0-9]{1,12}$/.test(dest.value)) throw bad(`A ${dest.type} destination needs a valid id`);
  if (dest.type === 'hangup' && !HANGUP_REASONS.includes(dest.value)) throw bad('Hangup destination must be busy, congestion or reject');
  if (dest.type === 'echo' && dest.value !== '') throw bad('The echo destination takes no value');

  const exists = async (sql, p) => (await db.query(sql, p)).rows.length > 0;
  if (dest.type === 'extension' && !(await exists('SELECT 1 FROM extensions WHERE number = $1', [dest.value]))) throw bad(`Extension ${dest.value} does not exist`);
  if (dest.type === 'ringgroup' && !(await exists('SELECT 1 FROM ring_groups WHERE number = $1', [dest.value]))) throw bad(`Ring group ${dest.value} does not exist`);
  if (dest.type === 'timecondition' && !(await exists('SELECT 1 FROM time_conditions WHERE id = $1', [dest.value]))) throw bad(`Time condition ${dest.value} does not exist`);
  if (dest.type === 'conference' && !(await exists('SELECT 1 FROM conferences WHERE number = $1', [dest.value]))) throw bad(`Conference room ${dest.value} does not exist`);
  if (dest.type === 'voicemail' && !(await exists('SELECT 1 FROM extensions WHERE number = $1 AND voicemail_enabled', [dest.value]))) throw bad(`Extension ${dest.value} has no voicemail`);
  if (dest.type === 'queue' && !(await exists('SELECT 1 FROM queues WHERE number = $1', [dest.value]))) throw bad(`Queue ${dest.value} does not exist`);
  if (dest.type === 'ivr' && !(await exists('SELECT 1 FROM ivrs WHERE number = $1', [dest.value]))) throw bad(`Menu ${dest.value} does not exist`);
  if (dest.type === 'announcement' && !(await exists('SELECT 1 FROM announcements WHERE id = $1', [dest.value]))) throw bad(`Announcement ${dest.value} does not exist`);
}

/**
 * Everything that currently sends calls to (type, value), as human-readable strings. Used to refuse deleting
 * something that is still in use instead of leaving a route that silently hangs up.
 */
async function references(db, type, value, { exclude = null } = {}) {
  const out = [];
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  for (const r of await q('SELECT name FROM inbound_routes WHERE dest_type = $1 AND dest_value = $2', [type, value])) out.push(`inbound route "${r.name}"`);
  for (const r of await q(`SELECT name FROM trunks WHERE inbound_default->>'type' = $1 AND inbound_default->>'value' = $2`, [type, value])) out.push(`trunk "${r.name}" default destination`);
  for (const col of ['fwd_all', 'fwd_busy', 'fwd_noanswer']) {
    for (const r of await q(`SELECT number FROM extensions WHERE ${col}->>'type' = $1 AND ${col}->>'value' = $2`, [type, value])) {
      if (exclude !== `extension:${r.number}`) out.push(`extension ${r.number} forwarding`);
    }
  }
  for (const r of await q(`SELECT number FROM ring_groups WHERE fail_dest->>'type' = $1 AND fail_dest->>'value' = $2`, [type, value])) {
    if (exclude !== `ringgroup:${r.number}`) out.push(`ring group ${r.number} fallback`);
  }
  for (const r of await q(`SELECT id, name FROM time_conditions WHERE (match_dest->>'type' = $1 AND match_dest->>'value' = $2) OR (nomatch_dest->>'type' = $1 AND nomatch_dest->>'value' = $2)`, [type, value])) {
    if (exclude !== `timecondition:${r.id}`) out.push(`time condition "${r.name}"`);
  }
  for (const r of await q(`SELECT number FROM queues WHERE fail_dest->>'type' = $1 AND fail_dest->>'value' = $2`, [type, value])) {
    if (exclude !== `queue:${r.number}`) out.push(`queue ${r.number} fallback`);
  }
  for (const r of await q(`SELECT number FROM ivrs WHERE fail_dest->>'type' = $1 AND fail_dest->>'value' = $2`, [type, value])) {
    if (exclude !== `ivr:${r.number}`) out.push(`menu ${r.number} fallback`);
  }
  for (const r of await q(
    `SELECT DISTINCT i.number FROM ivrs i, jsonb_array_elements(i.options) o WHERE o->'dest'->>'type' = $1 AND o->'dest'->>'value' = $2`, [type, value])) {
    if (exclude !== `ivr:${r.number}`) out.push(`menu ${r.number} option`);
  }
  for (const r of await q(`SELECT id, name FROM announcements WHERE next_dest->>'type' = $1 AND next_dest->>'value' = $2`, [type, value])) {
    if (exclude !== `announcement:${r.id}`) out.push(`announcement "${r.name}"`);
  }
  return [...new Set(out)];
}

module.exports = { DEST_TYPES, HANGUP_REASONS, destinationSchema, dstContext, assertValid, references, label };
