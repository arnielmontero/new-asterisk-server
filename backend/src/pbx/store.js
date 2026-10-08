'use strict';
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { toTelephonyWav } = require('./wav');
const { conflict, notFound, badRequest } = require('../errors');
const { RESERVED_NUMBERS, trunkRules } = require('./schemas');
const destinations = require('./destinations');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Cryptographically random secret that is always valid for the SIP secret schema. */
function generateSecret(length = 20) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const publicExtension = (r) => ({
  id: Number(r.id),
  number: r.number,
  display_name: r.display_name,
  webrtc_enabled: r.webrtc_enabled,
  phone_enabled: r.phone_enabled,
  allow_outbound: r.allow_outbound,
  outbound_cid: r.outbound_cid,
  enabled: r.enabled,
  notes: r.notes,
  user: r.username || null,
  dnd: r.dnd,
  fwd_all: r.fwd_all || null,
  fwd_busy: r.fwd_busy || null,
  fwd_noanswer: r.fwd_noanswer || null,
  noanswer_secs: r.noanswer_secs,
  voicemail_enabled: r.voicemail_enabled,
  voicemail_greeting_id: r.voicemail_greeting_id === null || r.voicemail_greeting_id === undefined ? null : Number(r.voicemail_greeting_id),
  voicemail_max_secs: r.voicemail_max_secs,
  record_calls: r.record_calls,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const publicTrunk = (r) => {
  const { password, ...rest } = r;
  return { ...rest, id: Number(r.id), has_password: !!password };
};

class PbxStore {
  constructor(db, { mediaDir = null } = {}) {
    this.db = db;
    this.mediaDir = mediaDir;
  }

  // ------------------------------------------------------------------ helpers
  translate(err, what) {
    if (err && err.code === '23505') return conflict(`That ${what} already exists`, 'duplicate');
    if (err && err.code === '23503') return badRequest(`A referenced ${what} does not exist`, 'bad_reference');
    return err;
  }

  /** A number may be an extension, a paging group, or reserved, never two of them. */
  async assertNumberFree(number, { exceptExtensionId = null, exceptGroupId = null, exceptRingGroupId = null, exceptIvrId = null, exceptQueueId = null, exceptConferenceId = null } = {}) {
    if (RESERVED_NUMBERS.has(number)) throw conflict(`${number} is reserved (echo test)`, 'number_reserved');
    const e = (await this.db.query('SELECT id FROM extensions WHERE number = $1', [number])).rows[0];
    if (e && Number(e.id) !== exceptExtensionId) throw conflict(`${number} is already an extension`, 'number_in_use');
    const g = (await this.db.query('SELECT id FROM paging_groups WHERE number = $1', [number])).rows[0];
    if (g && Number(g.id) !== exceptGroupId) throw conflict(`${number} is already a paging group`, 'number_in_use');
    const rg = (await this.db.query('SELECT id FROM ring_groups WHERE number = $1', [number])).rows[0];
    if (rg && Number(rg.id) !== exceptRingGroupId) throw conflict(`${number} is already a ring group`, 'number_in_use');
    const iv = (await this.db.query('SELECT id FROM ivrs WHERE number = $1', [number])).rows[0];
    if (iv && Number(iv.id) !== exceptIvrId) throw conflict(`${number} is already a menu`, 'number_in_use');
    const qu = (await this.db.query('SELECT id FROM queues WHERE number = $1', [number])).rows[0];
    if (qu && Number(qu.id) !== exceptQueueId) throw conflict(`${number} is already a queue`, 'number_in_use');
    const cf = (await this.db.query('SELECT id FROM conferences WHERE number = $1', [number])).rows[0];
    if (cf && Number(cf.id) !== exceptConferenceId) throw conflict(`${number} is already a conference room`, 'number_in_use');
  }

  // --------------------------------------------------------------- extensions
  async listExtensions() {
    const { rows } = await this.db.query(
      `SELECT e.*, u.username FROM extensions e LEFT JOIN users u ON u.extension = e.number ORDER BY e.number`,
    );
    return rows.map(publicExtension);
  }

  async getExtension(id) {
    const row = (await this.db.query(
      `SELECT e.*, u.username FROM extensions e LEFT JOIN users u ON u.extension = e.number WHERE e.id = $1`, [id],
    )).rows[0];
    if (!row) throw notFound('Extension not found');
    return publicExtension(row);
  }

  async getExtensionSecrets(id) {
    const row = (await this.db.query('SELECT number, secret, phone_secret FROM extensions WHERE id = $1', [id])).rows[0];
    if (!row) throw notFound('Extension not found');
    return row;
  }

  async getExtensionSecretsByNumber(number) {
    const row = (await this.db.query('SELECT number, secret, phone_secret FROM extensions WHERE number = $1', [number])).rows[0];
    if (!row) throw notFound('Extension not found');
    return row;
  }

  async createExtension(data) {
    await this.assertNumberFree(data.number);
    await this.assertPromptExists(data.voicemail_greeting_id);
    const secret = data.secret || generateSecret();
    const phoneSecret = data.phone_secret || generateSecret();
    try {
      const { rows } = await this.db.query(
        `INSERT INTO extensions (number, display_name, secret, phone_secret, webrtc_enabled, phone_enabled,
                                 allow_outbound, outbound_cid, enabled, notes,
                                 voicemail_enabled, voicemail_greeting_id, voicemail_max_secs, record_calls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [data.number, data.display_name, secret, phoneSecret, data.webrtc_enabled, data.phone_enabled,
          data.allow_outbound, data.outbound_cid, data.enabled, data.notes,
          data.voicemail_enabled ?? false, data.voicemail_greeting_id ?? null, data.voicemail_max_secs ?? 120, data.record_calls ?? false],
      );
      return this.getExtension(rows[0].id);
    } catch (err) {
      throw this.translate(err, 'extension');
    }
  }

  async updateExtension(id, patch) {
    const current = await this.getExtension(id);
    if (patch.voicemail_greeting_id !== undefined) await this.assertPromptExists(patch.voicemail_greeting_id);
    if (patch.voicemail_enabled === false && current.voicemail_enabled) {
      const usedIn = await destinations.references(this.db, 'voicemail', current.number);
      if (usedIn.length) throw conflict(`Voicemail for ${current.number} is still used by: ${usedIn.join(', ')}`, 'in_use');
    }
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (['fwd_all', 'fwd_busy', 'fwd_noanswer'].includes(key) && value) {
        if (value.type === 'extension' && value.value === current.number) throw badRequest('An extension cannot forward to itself', 'bad_destination');
        await destinations.assertValid(this.db, value);
      }
      params.push(['fwd_all', 'fwd_busy', 'fwd_noanswer'].includes(key) && value ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(id);
    await this.db.query(`UPDATE extensions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    return this.getExtension(id);
  }

  async regenerateSecrets(id, which) {
    await this.getExtension(id);
    const sets = [];
    const params = [];
    if (which === 'browser' || which === 'both') { params.push(generateSecret()); sets.push(`secret = $${params.length}`); }
    if (which === 'phone' || which === 'both') { params.push(generateSecret()); sets.push(`phone_secret = $${params.length}`); }
    params.push(id);
    await this.db.query(`UPDATE extensions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    return this.getExtensionSecrets(id);
  }

  async deleteExtension(id) {
    const ext = await this.getExtension(id);
    const usedIn = [
      ...(await destinations.references(this.db, 'extension', ext.number, { exclude: `extension:${ext.number}` })),
      ...(await destinations.references(this.db, 'voicemail', ext.number)),
    ];
    if (usedIn.length) throw conflict(`Extension ${ext.number} is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM extensions WHERE id = $1', [id]);
    // Its messages go with it (the audio files are removed too).
    const gone = (await this.db.query('DELETE FROM voicemails WHERE extension = $1 RETURNING file', [ext.number])).rows;
    if (this.mediaDir) for (const m of gone) await fsp.unlink(path.join(this.mediaDir, 'voicemail', m.file)).catch(() => {});
    return ext;
  }

  // ------------------------------------------------------------ paging groups
  async listPagingGroups() {
    const { rows } = await this.db.query(
      `SELECT g.*, COALESCE(array_agg(e.number ORDER BY e.number) FILTER (WHERE e.id IS NOT NULL), '{}') AS members
       FROM paging_groups g
       LEFT JOIN paging_group_members m ON m.group_id = g.id
       LEFT JOIN extensions e ON e.id = m.extension_id
       GROUP BY g.id ORDER BY g.number`,
    );
    return rows.map((r) => ({ id: Number(r.id), number: r.number, name: r.name, enabled: r.enabled, members: r.members }));
  }

  async getPagingGroup(id) {
    const g = (await this.listPagingGroups()).find((x) => x.id === id);
    if (!g) throw notFound('Paging group not found');
    return g;
  }

  async setGroupMembers(client, groupId, members) {
    await client.query('DELETE FROM paging_group_members WHERE group_id = $1', [groupId]);
    if (!members.length) return;
    const unique = [...new Set(members)];
    const found = (await client.query('SELECT id, number FROM extensions WHERE number = ANY($1::text[])', [unique])).rows;
    if (found.length !== unique.length) {
      const known = new Set(found.map((r) => r.number));
      throw badRequest(`Unknown extension(s): ${unique.filter((n) => !known.has(n)).join(', ')}`, 'unknown_extension');
    }
    for (const row of found) {
      await client.query('INSERT INTO paging_group_members (group_id, extension_id) VALUES ($1, $2)', [groupId, row.id]);
    }
  }

  async createPagingGroup(data) {
    await this.assertNumberFree(data.number);
    try {
      const id = await this.db.tx(async (c) => {
        const { rows } = await c.query('INSERT INTO paging_groups (number, name, enabled) VALUES ($1,$2,$3) RETURNING id', [data.number, data.name, data.enabled]);
        await this.setGroupMembers(c, rows[0].id, data.members);
        return Number(rows[0].id);
      });
      return this.getPagingGroup(id);
    } catch (err) {
      throw this.translate(err, 'paging group');
    }
  }

  async updatePagingGroup(id, patch) {
    await this.getPagingGroup(id);
    await this.db.tx(async (c) => {
      const sets = [];
      const params = [];
      for (const key of ['name', 'enabled']) {
        if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${key} = $${params.length}`); }
      }
      if (sets.length) {
        params.push(id);
        await c.query(`UPDATE paging_groups SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      if (patch.members) await this.setGroupMembers(c, id, patch.members);
    });
    return this.getPagingGroup(id);
  }

  async deletePagingGroup(id) {
    const g = await this.getPagingGroup(id);
    await this.db.query('DELETE FROM paging_groups WHERE id = $1', [id]);
    return g;
  }

  // ------------------------------------------------------------------- trunks
  async listTrunks() {
    return (await this.db.query('SELECT * FROM trunks ORDER BY name')).rows.map(publicTrunk);
  }

  async getTrunkRow(id) {
    const row = (await this.db.query('SELECT * FROM trunks WHERE id = $1', [id])).rows[0];
    if (!row) throw notFound('Trunk not found');
    return row;
  }

  async getTrunk(id) {
    return publicTrunk(await this.getTrunkRow(id));
  }

  assertTrunkValid(t) {
    const issues = trunkRules(t);
    if (issues.length) throw badRequest('Invalid request', 'validation_error', issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  async assertInboundDefault(dest) {
    if (dest) await this.assertDestination(dest);
  }

  async assertExtensionExists(number) {
    const r = (await this.db.query('SELECT 1 FROM extensions WHERE number = $1', [number])).rows[0];
    if (!r) throw badRequest(`Extension ${number} does not exist`, 'unknown_extension');
  }

  /**
   * Inbound calls are matched to a trunk by source address. Two enabled trunks that accept the same address (and are
   * not both registration trunks, which are told apart by their registered line) would be ambiguous: whichever Asterisk
   * loaded first would get the call. Refuse that instead of letting calls land in the wrong trunk's routes.
   */
  async assertNoAddressClash(trunk, exceptId = null) {
    if (!trunk.enabled) return;
    const mine = new Set([trunk.host, ...(trunk.match_ips || [])].map((a) => String(a).toLowerCase()));
    const others = (await this.db.query('SELECT id, name, auth_mode, host, match_ips FROM trunks WHERE enabled')).rows;
    for (const o of others) {
      if (exceptId !== null && Number(o.id) === exceptId) continue;
      if (trunk.auth_mode === 'register' && o.auth_mode === 'register') continue;
      const theirs = [o.host, ...(o.match_ips || [])].map((a) => String(a).toLowerCase());
      const shared = theirs.find((a) => mine.has(a));
      if (shared) {
        throw conflict(`Trunk "${o.name}" already accepts calls from ${shared}: two trunks cannot share an address, because inbound calls could not be told apart`, 'address_in_use');
      }
    }
  }

  async createTrunk(data) {
    this.assertTrunkValid(data);
    await this.assertNoAddressClash(data);
    await this.assertInboundDefault(data.inbound_default);
    try {
      const { rows } = await this.db.query(
        `INSERT INTO trunks (name, display_name, kind, auth_mode, host, port, transport, username, password, auth_username,
                             from_user, from_domain, register_expiry, codecs, dtmf_mode, max_channels, caller_id_num,
                             caller_id_name, match_ips, inbound_default, qualify, enabled, notes, record_calls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
        [data.name, data.display_name, data.kind, data.auth_mode, data.host, data.port, data.transport, data.username,
          data.password, data.auth_username, data.from_user, data.from_domain, data.register_expiry, data.codecs,
          data.dtmf_mode, data.max_channels, data.caller_id_num, data.caller_id_name, data.match_ips,
          data.inbound_default ? JSON.stringify(data.inbound_default) : null, data.qualify, data.enabled, data.notes, data.record_calls ?? false],
      );
      return this.getTrunk(rows[0].id);
    } catch (err) {
      throw this.translate(err, 'trunk');
    }
  }

  async updateTrunk(id, patch) {
    const current = await this.getTrunkRow(id);
    const next = { ...current, ...patch };
    // An empty/omitted password keeps the stored one.
    if (patch.password === undefined || patch.password === null) next.password = current.password;
    this.assertTrunkValid(next);
    await this.assertNoAddressClash(next, id);
    if (patch.inbound_default !== undefined) await this.assertInboundDefault(patch.inbound_default);
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'password' && (value === undefined || value === null)) continue;
      params.push(key === 'inbound_default' && value ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await this.db.query(`UPDATE trunks SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    return this.getTrunk(id);
  }

  async deleteTrunk(id) {
    const t = await this.getTrunk(id);
    const used = (await this.db.query(
      `SELECT r.name FROM outbound_route_trunks rt JOIN outbound_routes r ON r.id = rt.route_id WHERE rt.trunk_id = $1`, [id])).rows;
    const inbound = (await this.db.query('SELECT name FROM inbound_routes WHERE trunk_id = $1', [id])).rows;
    const usedIn = [...used.map((r) => `outbound route "${r.name}"`), ...inbound.map((r) => `inbound route "${r.name}"`)];
    if (usedIn.length) throw conflict(`Trunk "${t.name}" is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM trunks WHERE id = $1', [id]);
    return t;
  }

  // ------------------------------------------------------------ inbound routes
  async listInbound() {
    const { rows } = await this.db.query(
      `SELECT r.*, t.name AS trunk_name FROM inbound_routes r LEFT JOIN trunks t ON t.id = r.trunk_id ORDER BY r.did, r.id`,
    );
    return rows.map(inboundShape);
  }

  async getInbound(id) {
    const row = (await this.db.query(
      `SELECT r.*, t.name AS trunk_name FROM inbound_routes r LEFT JOIN trunks t ON t.id = r.trunk_id WHERE r.id = $1`, [id],
    )).rows[0];
    if (!row) throw notFound('Inbound route not found');
    return inboundShape(row);
  }

  async assertDestination(dest) {
    await destinations.assertValid(this.db, dest);
  }

  async createInbound(data) {
    await this.assertDestination(data.destination);
    try {
      const { rows } = await this.db.query(
        `INSERT INTO inbound_routes (name, did, trunk_id, dest_type, dest_value, cid_name_prefix, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [data.name, data.did, data.trunk_id, data.destination.type, data.destination.value, data.cid_name_prefix, data.enabled],
      );
      return this.getInbound(rows[0].id);
    } catch (err) {
      if (err.code === '23505') throw conflict('An inbound route for that number already exists on that trunk', 'duplicate');
      throw this.translate(err, 'trunk');
    }
  }

  async updateInbound(id, patch) {
    await this.getInbound(id);
    const cols = { name: 'name', did: 'did', trunk_id: 'trunk_id', cid_name_prefix: 'cid_name_prefix', enabled: 'enabled' };
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(cols)) {
      if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${col} = $${params.length}`); }
    }
    if (patch.destination) {
      await this.assertDestination(patch.destination);
      params.push(patch.destination.type); sets.push(`dest_type = $${params.length}`);
      params.push(patch.destination.value); sets.push(`dest_value = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      try {
        await this.db.query(`UPDATE inbound_routes SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      } catch (err) {
        if (err.code === '23505') throw conflict('An inbound route for that number already exists on that trunk', 'duplicate');
        throw this.translate(err, 'trunk');
      }
    }
    return this.getInbound(id);
  }

  async deleteInbound(id) {
    const r = await this.getInbound(id);
    await this.db.query('DELETE FROM inbound_routes WHERE id = $1', [id]);
    return r;
  }

  // ----------------------------------------------------------- outbound routes
  async listOutbound() {
    const { rows } = await this.db.query(
      `SELECT r.*, COALESCE(json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY rt.position)
              FILTER (WHERE t.id IS NOT NULL), '[]') AS trunk_list
       FROM outbound_routes r
       LEFT JOIN outbound_route_trunks rt ON rt.route_id = r.id
       LEFT JOIN trunks t ON t.id = rt.trunk_id
       GROUP BY r.id ORDER BY r.position, r.id`,
    );
    return rows.map(outboundShape);
  }

  async getOutbound(id) {
    const r = (await this.listOutbound()).find((x) => x.id === id);
    if (!r) throw notFound('Outbound route not found');
    return r;
  }

  async setRouteTrunks(client, routeId, trunkIds) {
    await client.query('DELETE FROM outbound_route_trunks WHERE route_id = $1', [routeId]);
    const unique = [...new Set(trunkIds)];
    const found = (await client.query('SELECT id FROM trunks WHERE id = ANY($1::bigint[])', [unique])).rows.map((r) => Number(r.id));
    if (found.length !== unique.length) throw badRequest('One or more trunks do not exist', 'unknown_trunk');
    let pos = 0;
    for (const trunkId of unique) {
      await client.query('INSERT INTO outbound_route_trunks (route_id, trunk_id, position) VALUES ($1,$2,$3)', [routeId, trunkId, pos]);
      pos += 1;
    }
  }

  async createOutbound(data) {
    try {
      const id = await this.db.tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO outbound_routes (name, patterns, strip, prepend, cid_num, emergency, position, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [data.name, data.patterns, data.strip, data.prepend, data.cid_num, data.emergency, data.position, data.enabled],
        );
        await this.setRouteTrunks(c, rows[0].id, data.trunks);
        return Number(rows[0].id);
      });
      return this.getOutbound(id);
    } catch (err) {
      if (err.code === '23505') throw conflict('An outbound route with that name already exists', 'duplicate');
      throw err;
    }
  }

  async updateOutbound(id, patch) {
    await this.getOutbound(id);
    try {
      await this.db.tx(async (c) => {
        const sets = [];
        const params = [];
        for (const key of ['name', 'patterns', 'strip', 'prepend', 'cid_num', 'emergency', 'position', 'enabled']) {
          if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${key} = $${params.length}`); }
        }
        if (sets.length) {
          params.push(id);
          await c.query(`UPDATE outbound_routes SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        }
        if (patch.trunks) await this.setRouteTrunks(c, id, patch.trunks);
      });
    } catch (err) {
      if (err.code === '23505') throw conflict('An outbound route with that name already exists', 'duplicate');
      throw err;
    }
    return this.getOutbound(id);
  }

  async deleteOutbound(id) {
    const r = await this.getOutbound(id);
    await this.db.query('DELETE FROM outbound_routes WHERE id = $1', [id]);
    return r;
  }

  // --------------------------------------------------------------- ring groups
  async listRingGroups() {
    const { rows } = await this.db.query(
      `SELECT g.*, COALESCE(array_agg(e.number ORDER BY m.position) FILTER (WHERE e.id IS NOT NULL), '{}') AS members
       FROM ring_groups g
       LEFT JOIN ring_group_members m ON m.group_id = g.id
       LEFT JOIN extensions e ON e.id = m.extension_id
       GROUP BY g.id ORDER BY g.number`,
    );
    return rows.map((r) => ({
      id: Number(r.id), number: r.number, name: r.name, strategy: r.strategy, ring_secs: r.ring_secs,
      fail_dest: r.fail_dest || null, enabled: r.enabled, members: r.members,
    }));
  }

  async getRingGroup(id) {
    const g = (await this.listRingGroups()).find((x) => x.id === id);
    if (!g) throw notFound('Ring group not found');
    return g;
  }

  async setRingMembers(client, groupId, members) {
    await client.query('DELETE FROM ring_group_members WHERE group_id = $1', [groupId]);
    const unique = [...new Set(members)];
    const found = (await client.query('SELECT id, number FROM extensions WHERE number = ANY($1::text[])', [unique])).rows;
    if (found.length !== unique.length) {
      const known = new Set(found.map((r) => r.number));
      throw badRequest(`Unknown extension(s): ${unique.filter((n) => !known.has(n)).join(', ')}`, 'unknown_extension');
    }
    const byNumber = new Map(found.map((r) => [r.number, r.id]));
    let pos = 0;
    for (const number of unique) {
      await client.query('INSERT INTO ring_group_members (group_id, extension_id, position) VALUES ($1,$2,$3)', [groupId, byNumber.get(number), pos]);
      pos += 1;
    }
  }

  async createRingGroup(data) {
    await this.assertNumberFree(data.number);
    await destinations.assertValid(this.db, data.fail_dest);
    const id = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ring_groups (number, name, strategy, ring_secs, fail_dest, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [data.number, data.name, data.strategy, data.ring_secs, data.fail_dest ? JSON.stringify(data.fail_dest) : null, data.enabled],
      );
      await this.setRingMembers(c, rows[0].id, data.members);
      return Number(rows[0].id);
    });
    return this.getRingGroup(id);
  }

  async updateRingGroup(id, patch) {
    const current = await this.getRingGroup(id);
    if (patch.fail_dest) {
      if (patch.fail_dest.type === 'ringgroup' && patch.fail_dest.value === current.number) throw badRequest('A ring group cannot fall back to itself', 'bad_destination');
      await destinations.assertValid(this.db, patch.fail_dest);
    }
    await this.db.tx(async (c) => {
      const sets = [];
      const params = [];
      for (const key of ['name', 'strategy', 'ring_secs', 'enabled']) {
        if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${key} = $${params.length}`); }
      }
      if (patch.fail_dest !== undefined) { params.push(patch.fail_dest ? JSON.stringify(patch.fail_dest) : null); sets.push(`fail_dest = $${params.length}`); }
      if (sets.length) {
        params.push(id);
        await c.query(`UPDATE ring_groups SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      if (patch.members) await this.setRingMembers(c, id, patch.members);
    });
    return this.getRingGroup(id);
  }

  async deleteRingGroup(id) {
    const g = await this.getRingGroup(id);
    const usedIn = await destinations.references(this.db, 'ringgroup', g.number, { exclude: `ringgroup:${g.number}` });
    if (usedIn.length) throw conflict(`Ring group ${g.number} is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM ring_groups WHERE id = $1', [id]);
    return g;
  }

  // ---------------------------------------------------------- time conditions
  async listTimeConditions() {
    const { rows } = await this.db.query('SELECT * FROM time_conditions ORDER BY name');
    return rows.map((r) => ({
      id: Number(r.id), name: r.name, timezone: r.timezone, rules: r.rules, holidays: r.holidays,
      match_dest: r.match_dest, nomatch_dest: r.nomatch_dest, override: r.override, enabled: r.enabled,
    }));
  }

  async getTimeCondition(id) {
    const t = (await this.listTimeConditions()).find((x) => x.id === id);
    if (!t) throw notFound('Time condition not found');
    return t;
  }

  async createTimeCondition(data) {
    await destinations.assertValid(this.db, data.match_dest);
    await destinations.assertValid(this.db, data.nomatch_dest);
    try {
      const { rows } = await this.db.query(
        `INSERT INTO time_conditions (name, timezone, rules, holidays, match_dest, nomatch_dest, override, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [data.name, data.timezone, JSON.stringify(data.rules), JSON.stringify(data.holidays), JSON.stringify(data.match_dest),
          JSON.stringify(data.nomatch_dest), data.override, data.enabled],
      );
      return this.getTimeCondition(Number(rows[0].id));
    } catch (err) {
      if (err.code === '23505') throw conflict('A time condition with that name already exists', 'duplicate');
      throw err;
    }
  }

  async updateTimeCondition(id, patch) {
    await this.getTimeCondition(id);
    for (const key of ['match_dest', 'nomatch_dest']) {
      if (patch[key]) {
        if (patch[key].type === 'timecondition' && patch[key].value === String(id)) throw badRequest('A time condition cannot route to itself', 'bad_destination');
        await destinations.assertValid(this.db, patch[key]);
      }
    }
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      params.push(['rules', 'holidays', 'match_dest', 'nomatch_dest'].includes(key) ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(id);
    try {
      await this.db.query(`UPDATE time_conditions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    } catch (err) {
      if (err.code === '23505') throw conflict('A time condition with that name already exists', 'duplicate');
      throw err;
    }
    return this.getTimeCondition(id);
  }

  async deleteTimeCondition(id) {
    const t = await this.getTimeCondition(id);
    const usedIn = await destinations.references(this.db, 'timecondition', String(id), { exclude: `timecondition:${id}` });
    if (usedIn.length) throw conflict(`Time condition "${t.name}" is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM time_conditions WHERE id = $1', [id]);
    return t;
  }

  // ------------------------------------------------------------------ prompts
  promptFile(id) {
    if (!this.mediaDir) throw new Error('media directory is not configured');
    return path.join(this.mediaDir, 'prompts', `${Number(id)}.wav`);
  }

  async listPrompts() {
    const { rows } = await this.db.query(
      `SELECT p.*, (EXISTS (SELECT 1 FROM ivrs i WHERE i.prompt_id = p.id) OR EXISTS (SELECT 1 FROM announcements a WHERE a.prompt_id = p.id) OR EXISTS (SELECT 1 FROM extensions x WHERE x.voicemail_greeting_id = p.id)) AS in_use
       FROM prompts p ORDER BY p.name`,
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.name, duration_ms: r.duration_ms, size_bytes: r.size_bytes, in_use: r.in_use, created_at: r.created_at }));
  }

  async getPrompt(id) {
    const p = (await this.listPrompts()).find((x) => x.id === id);
    if (!p) throw notFound('Prompt not found');
    return p;
  }

  /** Convert an uploaded WAV to telephone format and store it. The database row and the file are created together. */
  async createPrompt(name, buffer) {
    const { wav, durationMs } = toTelephonyWav(buffer);
    let id;
    try {
      const { rows } = await this.db.query('INSERT INTO prompts (name, duration_ms, size_bytes) VALUES ($1,$2,$3) RETURNING id', [name, durationMs, wav.length]);
      id = Number(rows[0].id);
    } catch (err) {
      if (err.code === '23505') throw conflict('A prompt with that name already exists', 'duplicate');
      throw err;
    }
    try {
      const file = this.promptFile(id);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, wav, { mode: 0o644 });
    } catch (err) {
      await this.db.query('DELETE FROM prompts WHERE id = $1', [id]);
      throw err;
    }
    return this.getPrompt(id);
  }

  async renamePrompt(id, name) {
    await this.getPrompt(id);
    try {
      await this.db.query('UPDATE prompts SET name = $1 WHERE id = $2', [name, id]);
    } catch (err) {
      if (err.code === '23505') throw conflict('A prompt with that name already exists', 'duplicate');
      throw err;
    }
    return this.getPrompt(id);
  }

  async deletePrompt(id) {
    const p = await this.getPrompt(id);
    if (p.in_use) {
      const ivrs = (await this.db.query('SELECT number FROM ivrs WHERE prompt_id = $1', [id])).rows.map((r) => `menu ${r.number}`);
      const anns = (await this.db.query('SELECT name FROM announcements WHERE prompt_id = $1', [id])).rows.map((r) => `announcement "${r.name}"`);
      const boxes = (await this.db.query('SELECT number FROM extensions WHERE voicemail_greeting_id = $1', [id])).rows.map((r) => `voicemail greeting of extension ${r.number}`);
      throw conflict(`Prompt "${p.name}" is still used by: ${[...ivrs, ...anns, ...boxes].join(', ')}`, 'in_use');
    }
    await this.db.query('DELETE FROM prompts WHERE id = $1', [id]);
    await fsp.unlink(this.promptFile(id)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    return p;
  }

  async assertPromptExists(id) {
    if (id === null || id === undefined) return;
    const r = (await this.db.query('SELECT 1 FROM prompts WHERE id = $1', [id])).rows[0];
    if (!r) throw badRequest('That prompt does not exist', 'unknown_prompt');
  }

  // ------------------------------------------------------------- announcements
  async listAnnouncements() {
    const { rows } = await this.db.query(
      'SELECT a.*, p.name AS prompt_name FROM announcements a JOIN prompts p ON p.id = a.prompt_id ORDER BY a.name',
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.name, prompt_id: Number(r.prompt_id), prompt_name: r.prompt_name, next_dest: r.next_dest || null, enabled: r.enabled }));
  }

  async getAnnouncement(id) {
    const a = (await this.listAnnouncements()).find((x) => x.id === id);
    if (!a) throw notFound('Announcement not found');
    return a;
  }

  async createAnnouncement(data) {
    await this.assertPromptExists(data.prompt_id);
    await destinations.assertValid(this.db, data.next_dest);
    try {
      const { rows } = await this.db.query(
        'INSERT INTO announcements (name, prompt_id, next_dest, enabled) VALUES ($1,$2,$3,$4) RETURNING id',
        [data.name, data.prompt_id, data.next_dest ? JSON.stringify(data.next_dest) : null, data.enabled],
      );
      return this.getAnnouncement(Number(rows[0].id));
    } catch (err) {
      if (err.code === '23505') throw conflict('An announcement with that name already exists', 'duplicate');
      throw err;
    }
  }

  async updateAnnouncement(id, patch) {
    await this.getAnnouncement(id);
    if (patch.prompt_id !== undefined) await this.assertPromptExists(patch.prompt_id);
    if (patch.next_dest) {
      if (patch.next_dest.type === 'announcement' && patch.next_dest.value === String(id)) throw badRequest('An announcement cannot continue to itself', 'bad_destination');
      await destinations.assertValid(this.db, patch.next_dest);
    }
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      params.push(key === 'next_dest' && value ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(id);
    try {
      await this.db.query(`UPDATE announcements SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    } catch (err) {
      if (err.code === '23505') throw conflict('An announcement with that name already exists', 'duplicate');
      throw err;
    }
    return this.getAnnouncement(id);
  }

  async deleteAnnouncement(id) {
    const a = await this.getAnnouncement(id);
    const usedIn = await destinations.references(this.db, 'announcement', String(id), { exclude: `announcement:${id}` });
    if (usedIn.length) throw conflict(`Announcement "${a.name}" is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM announcements WHERE id = $1', [id]);
    return a;
  }

  // ---------------------------------------------------------------------- menus
  async listIvrs() {
    const { rows } = await this.db.query('SELECT i.*, p.name AS prompt_name FROM ivrs i LEFT JOIN prompts p ON p.id = i.prompt_id ORDER BY i.number');
    return rows.map((r) => ({
      id: Number(r.id), number: r.number, name: r.name, prompt_id: r.prompt_id === null ? null : Number(r.prompt_id), prompt_name: r.prompt_name || null,
      timeout_secs: r.timeout_secs, max_repeats: r.max_repeats, options: r.options, fail_dest: r.fail_dest || null,
      allow_extension_dial: r.allow_extension_dial, enabled: r.enabled,
    }));
  }

  async getIvr(id) {
    const i = (await this.listIvrs()).find((x) => x.id === id);
    if (!i) throw notFound('Menu not found');
    return i;
  }

  async assertIvrContent({ prompt_id: promptId, options, fail_dest: failDest }, selfNumber = null) {
    await this.assertPromptExists(promptId);
    for (const o of options || []) {
      if (selfNumber && o.dest.type === 'ivr' && o.dest.value === selfNumber) continue; // returning to the same menu is allowed
      await destinations.assertValid(this.db, o.dest);
    }
    if (failDest) {
      if (selfNumber && failDest.type === 'ivr' && failDest.value === selfNumber) throw badRequest('A menu cannot fall back to itself', 'bad_destination');
      await destinations.assertValid(this.db, failDest);
    }
  }

  async createIvr(data) {
    await this.assertNumberFree(data.number);
    await this.assertIvrContent(data, data.number);
    const { rows } = await this.db.query(
      `INSERT INTO ivrs (number, name, prompt_id, timeout_secs, max_repeats, options, fail_dest, allow_extension_dial, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [data.number, data.name, data.prompt_id, data.timeout_secs, data.max_repeats, JSON.stringify(data.options),
        data.fail_dest ? JSON.stringify(data.fail_dest) : null, data.allow_extension_dial, data.enabled],
    );
    return this.getIvr(Number(rows[0].id));
  }

  async updateIvr(id, patch) {
    const current = await this.getIvr(id);
    await this.assertIvrContent({ prompt_id: patch.prompt_id, options: patch.options, fail_dest: patch.fail_dest }, current.number);
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      params.push(['options', 'fail_dest'].includes(key) && value !== null ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(id);
    await this.db.query(`UPDATE ivrs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    return this.getIvr(id);
  }

  async deleteIvr(id) {
    const i = await this.getIvr(id);
    const usedIn = await destinations.references(this.db, 'ivr', i.number, { exclude: `ivr:${i.number}` });
    if (usedIn.length) throw conflict(`Menu ${i.number} is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM ivrs WHERE id = $1', [id]);
    return i;
  }

  // --------------------------------------------------------------------- queues
  async listQueues() {
    const { rows } = await this.db.query(
      `SELECT q.*, COALESCE(array_agg(e.number ORDER BY m.position) FILTER (WHERE e.id IS NOT NULL), '{}') AS members
       FROM queues q
       LEFT JOIN queue_members m ON m.queue_id = q.id
       LEFT JOIN extensions e ON e.id = m.extension_id
       GROUP BY q.id ORDER BY q.number`,
    );
    return rows.map((r) => ({
      id: Number(r.id), number: r.number, name: r.name, strategy: r.strategy, member_timeout: r.member_timeout,
      wrapup_secs: r.wrapup_secs, max_callers: r.max_callers, max_wait_secs: r.max_wait_secs, hold_when_empty: r.hold_when_empty,
      fail_dest: r.fail_dest || null, enabled: r.enabled, members: r.members,
    }));
  }

  async getQueue(id) {
    const q = (await this.listQueues()).find((x) => x.id === id);
    if (!q) throw notFound('Queue not found');
    return q;
  }

  async setQueueMembers(client, queueId, members) {
    await client.query('DELETE FROM queue_members WHERE queue_id = $1', [queueId]);
    const unique = [...new Set(members)];
    const found = (await client.query('SELECT id, number FROM extensions WHERE number = ANY($1::text[])', [unique])).rows;
    if (found.length !== unique.length) {
      const known = new Set(found.map((r) => r.number));
      throw badRequest(`Unknown extension(s): ${unique.filter((n) => !known.has(n)).join(', ')}`, 'unknown_extension');
    }
    const byNumber = new Map(found.map((r) => [r.number, r.id]));
    let pos = 0;
    for (const number of unique) {
      await client.query('INSERT INTO queue_members (queue_id, extension_id, position) VALUES ($1,$2,$3)', [queueId, byNumber.get(number), pos]);
      pos += 1;
    }
  }

  async createQueue(data) {
    await this.assertNumberFree(data.number);
    await destinations.assertValid(this.db, data.fail_dest);
    const id = await this.db.tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO queues (number, name, strategy, member_timeout, wrapup_secs, max_callers, max_wait_secs, hold_when_empty, fail_dest, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [data.number, data.name, data.strategy, data.member_timeout, data.wrapup_secs, data.max_callers, data.max_wait_secs,
          data.hold_when_empty, data.fail_dest ? JSON.stringify(data.fail_dest) : null, data.enabled],
      );
      await this.setQueueMembers(c, rows[0].id, data.members);
      return Number(rows[0].id);
    });
    return this.getQueue(id);
  }

  async updateQueue(id, patch) {
    const current = await this.getQueue(id);
    if (patch.fail_dest) {
      if (patch.fail_dest.type === 'queue' && patch.fail_dest.value === current.number) throw badRequest('A queue cannot fall back to itself', 'bad_destination');
      await destinations.assertValid(this.db, patch.fail_dest);
    }
    await this.db.tx(async (c) => {
      const sets = [];
      const params = [];
      for (const key of ['name', 'strategy', 'member_timeout', 'wrapup_secs', 'max_callers', 'max_wait_secs', 'hold_when_empty', 'enabled']) {
        if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${key} = $${params.length}`); }
      }
      if (patch.fail_dest !== undefined) { params.push(patch.fail_dest ? JSON.stringify(patch.fail_dest) : null); sets.push(`fail_dest = $${params.length}`); }
      if (sets.length) {
        params.push(id);
        await c.query(`UPDATE queues SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      if (patch.members) await this.setQueueMembers(c, id, patch.members);
    });
    return this.getQueue(id);
  }

  async deleteQueue(id) {
    const q = await this.getQueue(id);
    const usedIn = await destinations.references(this.db, 'queue', q.number, { exclude: `queue:${q.number}` });
    if (usedIn.length) throw conflict(`Queue ${q.number} is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM queues WHERE id = $1', [id]);
    return q;
  }

  // ---------------------------------------------------------------- bootstrap
  /**
   * The two seeded extensions get their credentials from the environment on the first start so an existing
   * deployment keeps working; every other extension gets generated secrets at creation time.
   */
  async fillMissingSecrets(seed) {
    const rows = (await this.db.query('SELECT id, number, secret, phone_secret FROM extensions WHERE secret IS NULL OR phone_secret IS NULL')).rows;
    for (const r of rows) {
      const s = r.secret || seed?.[r.number]?.secret || generateSecret();
      const p = r.phone_secret || seed?.[r.number]?.phone_secret || generateSecret();
      await this.db.query('UPDATE extensions SET secret = $1, phone_secret = $2 WHERE id = $3', [s, p, r.id]);
    }
    return rows.length;
  }

  // ---------------------------------------------------------------- conferences
  async listConferences() {
    const { rows } = await this.db.query('SELECT * FROM conferences ORDER BY number');
    return rows.map((r) => ({
      id: Number(r.id), number: r.number, name: r.name, pin: r.pin, admin_pin: r.admin_pin,
      mute_on_join: r.mute_on_join, max_members: r.max_members, enabled: r.enabled,
    }));
  }

  async getConference(id) {
    const c = (await this.listConferences()).find((x) => x.id === id);
    if (!c) throw notFound('Conference room not found');
    return c;
  }

  async createConference(data) {
    await this.assertNumberFree(data.number);
    try {
      const { rows } = await this.db.query(
        'INSERT INTO conferences (number, name, pin, admin_pin, mute_on_join, max_members, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [data.number, data.name, data.pin, data.admin_pin, data.mute_on_join, data.max_members, data.enabled],
      );
      return this.getConference(Number(rows[0].id));
    } catch (err) {
      throw this.translate(err, 'conference room');
    }
  }

  async updateConference(id, patch) {
    const current = await this.getConference(id);
    const next = { ...current, ...patch };
    if (next.pin && next.admin_pin && next.pin === next.admin_pin) throw badRequest('The room PIN and the administrator PIN must differ', 'validation_error');
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) { params.push(value); sets.push(`${key} = $${params.length}`); }
    params.push(id);
    await this.db.query(`UPDATE conferences SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    return this.getConference(id);
  }

  async deleteConference(id) {
    const c = await this.getConference(id);
    const usedIn = await destinations.references(this.db, 'conference', c.number);
    if (usedIn.length) throw conflict(`Conference room ${c.number} is still used by: ${usedIn.join(', ')}`, 'in_use');
    await this.db.query('DELETE FROM conferences WHERE id = $1', [id]);
    return c;
  }

  // ----------------------------------------------------------------- snapshot
  /** Everything the renderer and the live registry need, including secrets. Never sent to clients. */
  async snapshot() {
    const extensions = (await this.db.query('SELECT * FROM extensions ORDER BY number')).rows;
    const groups = await this.listPagingGroups();
    const trunks = (await this.db.query('SELECT * FROM trunks ORDER BY name')).rows;
    const inbound = (await this.db.query(
      `SELECT r.*, t.name AS trunk_name FROM inbound_routes r LEFT JOIN trunks t ON t.id = r.trunk_id ORDER BY r.id`)).rows;
    const outbound = await this.listOutbound();
    const ringGroups = await this.listRingGroups();
    const timeConditions = await this.listTimeConditions();
    const announcements = await this.listAnnouncements();
    const ivrs = await this.listIvrs();
    const queues = await this.listQueues();
    const conferences = await this.listConferences();
    return { extensions, groups, trunks, inbound: inbound.map(inboundShape), outbound, ringGroups, timeConditions, announcements, ivrs, queues, conferences };
  }
}

const inboundShape = (r) => ({
  id: Number(r.id),
  name: r.name,
  did: r.did,
  trunk_id: r.trunk_id === null ? null : Number(r.trunk_id),
  trunk_name: r.trunk_name || null,
  destination: { type: r.dest_type, value: r.dest_value },
  cid_name_prefix: r.cid_name_prefix,
  enabled: r.enabled,
});

const outboundShape = (r) => ({
  id: Number(r.id),
  name: r.name,
  patterns: r.patterns,
  strip: r.strip,
  prepend: r.prepend,
  cid_num: r.cid_num,
  emergency: r.emergency,
  position: r.position,
  enabled: r.enabled,
  trunks: r.trunk_list.map((t) => ({ id: Number(t.id), name: t.name })),
});

module.exports = { PbxStore, generateSecret, publicExtension, publicTrunk };
