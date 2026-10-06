'use strict';
const express = require('express');
const { z } = require('zod');
const { schemas } = require('./schemas');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');
const { badRequest } = require('../errors');

const regenerateBody = z.strictObject({ which: z.enum(['browser', 'phone', 'both']).optional().default('both') });

/** Mounted at /pbx behind authenticate + requireRole('admin'). Every change is audited and applied to Asterisk. */
function pbxRoutes({ store, applier, trunkStatus, queueService, audit, config }) {
  const router = express.Router();
  const id = validate({ params: schemas.idParam });

  const record = (req, action, target, details = null, status = 'success') =>
    audit.log({ user: req.user, action, target: String(target), ip: clientIp(req), status, details });

  // The apply happens in the background (debounced); the response never waits for Asterisk.
  const changed = (reason) => applier.schedule(reason);

  const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

  // ---------------------------------------------------------------- extensions
  router.get('/extensions', async (_req, res) => {
    res.json({ extensions: await store.listExtensions(), sipDomain: config.serverHostname });
  });

  router.get('/extensions/:id', id, async (req, res) => {
    res.json({ extension: await store.getExtension(req.valid.params.id) });
  });

  router.post('/extensions', validate({ body: schemas.createExtension }), async (req, res) => {
    try {
      const ext = await store.createExtension(req.valid.body);
      await record(req, 'pbx.extension.create', ext.number, without(ext, 'created_at', 'updated_at'));
      changed('extension.create');
      res.status(201).json({ extension: ext });
    } catch (err) {
      await record(req, 'pbx.extension.create', req.valid.body.number, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  router.patch('/extensions/:id', validate({ params: schemas.idParam, body: schemas.patchExtension }), async (req, res) => {
    const { secret, phone_secret: phoneSecret, ...rest } = req.valid.body;
    const ext = await store.updateExtension(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.extension.update', ext.number, { fields: Object.keys(rest), secretChanged: !!secret, phoneSecretChanged: !!phoneSecret });
    changed('extension.update');
    res.json({ extension: ext });
  });

  router.delete('/extensions/:id', id, async (req, res) => {
    try {
      const ext = await store.deleteExtension(req.valid.params.id);
      await record(req, 'pbx.extension.delete', ext.number);
      changed('extension.delete');
      res.json({ status: 'deleted', number: ext.number });
    } catch (err) {
      await record(req, 'pbx.extension.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // Credentials are shown on request only, over HTTPS, to administrators, and every view is audited.
  router.get('/extensions/:id/credentials', id, async (req, res) => {
    const s = await store.getExtensionSecrets(req.valid.params.id);
    await record(req, 'pbx.extension.credentials.view', s.number);
    res.set('Cache-Control', 'no-store');
    res.json({
      number: s.number,
      sipDomain: config.serverHostname,
      browser: { username: s.number, password: s.secret },
      phone: { username: `${s.number}-phone`, password: s.phone_secret },
    });
  });

  router.post('/extensions/:id/regenerate-secret', validate({ params: schemas.idParam, body: regenerateBody }), async (req, res) => {
    const s = await store.regenerateSecrets(req.valid.params.id, req.valid.body.which);
    await record(req, 'pbx.extension.secret.regenerate', s.number, { which: req.valid.body.which });
    changed('extension.secret');
    res.set('Cache-Control', 'no-store');
    res.json({
      number: s.number,
      sipDomain: config.serverHostname,
      browser: { username: s.number, password: s.secret },
      phone: { username: `${s.number}-phone`, password: s.phone_secret },
    });
  });

  // ------------------------------------------------------------ paging groups
  router.get('/paging-groups', async (_req, res) => {
    res.json({ groups: await store.listPagingGroups() });
  });

  router.post('/paging-groups', validate({ body: schemas.createPagingGroup }), async (req, res) => {
    const g = await store.createPagingGroup(req.valid.body);
    await record(req, 'pbx.paging_group.create', g.number, { name: g.name, members: g.members });
    changed('paging_group.create');
    res.status(201).json({ group: g });
  });

  router.patch('/paging-groups/:id', validate({ params: schemas.idParam, body: schemas.patchPagingGroup }), async (req, res) => {
    const g = await store.updatePagingGroup(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.paging_group.update', g.number, { fields: Object.keys(req.valid.body) });
    changed('paging_group.update');
    res.json({ group: g });
  });

  router.delete('/paging-groups/:id', id, async (req, res) => {
    const g = await store.deletePagingGroup(req.valid.params.id);
    await record(req, 'pbx.paging_group.delete', g.number);
    changed('paging_group.delete');
    res.json({ status: 'deleted', number: g.number });
  });

  // -------------------------------------------------------------------- trunks
  router.get('/trunks', async (_req, res) => {
    const trunks = await store.listTrunks();
    const live = new Map(trunkStatus.snapshot().map((s) => [s.name, s]));
    res.json({ trunks: trunks.map((t) => ({ ...t, status: live.get(t.name) || null })) });
  });

  router.get('/trunks/status', (_req, res) => {
    res.json({ trunks: trunkStatus.snapshot() });
  });

  router.get('/trunks/:id', id, async (req, res) => {
    res.json({ trunk: await store.getTrunk(req.valid.params.id) });
  });

  router.post('/trunks', validate({ body: schemas.createTrunk }), async (req, res) => {
    try {
      const t = await store.createTrunk(req.valid.body);
      await record(req, 'pbx.trunk.create', t.name, { auth_mode: t.auth_mode, host: t.host, kind: t.kind });
      changed('trunk.create');
      res.status(201).json({ trunk: t });
    } catch (err) {
      await record(req, 'pbx.trunk.create', req.valid.body.name, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  router.patch('/trunks/:id', validate({ params: schemas.idParam, body: schemas.patchTrunk }), async (req, res) => {
    const t = await store.updateTrunk(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.trunk.update', t.name, { fields: Object.keys(without(req.valid.body, 'password')), passwordChanged: !!req.valid.body.password });
    changed('trunk.update');
    res.json({ trunk: t });
  });

  router.delete('/trunks/:id', id, async (req, res) => {
    try {
      const t = await store.deleteTrunk(req.valid.params.id);
      await record(req, 'pbx.trunk.delete', t.name);
      changed('trunk.delete');
      res.json({ status: 'deleted', name: t.name });
    } catch (err) {
      await record(req, 'pbx.trunk.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // ------------------------------------------------------------ inbound routes
  router.get('/inbound-routes', async (_req, res) => {
    res.json({ routes: await store.listInbound() });
  });

  router.post('/inbound-routes', validate({ body: schemas.createInbound }), async (req, res) => {
    const r = await store.createInbound(req.valid.body);
    await record(req, 'pbx.inbound_route.create', r.did, { name: r.name, trunk: r.trunk_name, destination: r.destination });
    changed('inbound_route.create');
    res.status(201).json({ route: r });
  });

  router.patch('/inbound-routes/:id', validate({ params: schemas.idParam, body: schemas.patchInbound }), async (req, res) => {
    const r = await store.updateInbound(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.inbound_route.update', r.did, { fields: Object.keys(req.valid.body) });
    changed('inbound_route.update');
    res.json({ route: r });
  });

  router.delete('/inbound-routes/:id', id, async (req, res) => {
    const r = await store.deleteInbound(req.valid.params.id);
    await record(req, 'pbx.inbound_route.delete', r.did, { name: r.name });
    changed('inbound_route.delete');
    res.json({ status: 'deleted' });
  });

  // ----------------------------------------------------------- outbound routes
  router.get('/outbound-routes', async (_req, res) => {
    res.json({ routes: await store.listOutbound() });
  });

  router.post('/outbound-routes', validate({ body: schemas.createOutbound }), async (req, res) => {
    const r = await store.createOutbound(req.valid.body);
    await record(req, 'pbx.outbound_route.create', r.name, { patterns: r.patterns, trunks: r.trunks.map((t) => t.name), emergency: r.emergency });
    changed('outbound_route.create');
    res.status(201).json({ route: r });
  });

  router.patch('/outbound-routes/:id', validate({ params: schemas.idParam, body: schemas.patchOutbound }), async (req, res) => {
    const r = await store.updateOutbound(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.outbound_route.update', r.name, { fields: Object.keys(req.valid.body) });
    changed('outbound_route.update');
    res.json({ route: r });
  });

  router.delete('/outbound-routes/:id', id, async (req, res) => {
    const r = await store.deleteOutbound(req.valid.params.id);
    await record(req, 'pbx.outbound_route.delete', r.name);
    changed('outbound_route.delete');
    res.json({ status: 'deleted' });
  });

  // --------------------------------------------------------------- ring groups
  router.get('/ring-groups', async (_req, res) => {
    res.json({ groups: await store.listRingGroups() });
  });

  router.post('/ring-groups', validate({ body: schemas.createRingGroup }), async (req, res) => {
    try {
      const g = await store.createRingGroup(req.valid.body);
      await record(req, 'pbx.ring_group.create', g.number, { name: g.name, strategy: g.strategy, members: g.members });
      changed('ring_group.create');
      res.status(201).json({ group: g });
    } catch (err) {
      await record(req, 'pbx.ring_group.create', req.valid.body.number, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  router.patch('/ring-groups/:id', validate({ params: schemas.idParam, body: schemas.patchRingGroup }), async (req, res) => {
    const g = await store.updateRingGroup(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.ring_group.update', g.number, { fields: Object.keys(req.valid.body) });
    changed('ring_group.update');
    res.json({ group: g });
  });

  router.delete('/ring-groups/:id', id, async (req, res) => {
    try {
      const g = await store.deleteRingGroup(req.valid.params.id);
      await record(req, 'pbx.ring_group.delete', g.number);
      changed('ring_group.delete');
      res.json({ status: 'deleted', number: g.number });
    } catch (err) {
      await record(req, 'pbx.ring_group.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // ----------------------------------------------------------- time conditions
  router.get('/time-conditions', async (_req, res) => {
    res.json({ conditions: await store.listTimeConditions() });
  });

  router.post('/time-conditions', validate({ body: schemas.createTimeCondition }), async (req, res) => {
    const t = await store.createTimeCondition(req.valid.body);
    await record(req, 'pbx.time_condition.create', t.name, { timezone: t.timezone, rules: t.rules.length, holidays: t.holidays.length });
    changed('time_condition.create');
    res.status(201).json({ condition: t });
  });

  router.patch('/time-conditions/:id', validate({ params: schemas.idParam, body: schemas.patchTimeCondition }), async (req, res) => {
    const t = await store.updateTimeCondition(req.valid.params.id, req.valid.body);
    await record(req, req.valid.body.override ? 'pbx.time_condition.override' : 'pbx.time_condition.update', t.name,
      req.valid.body.override ? { override: req.valid.body.override } : { fields: Object.keys(req.valid.body) });
    changed('time_condition.update');
    res.json({ condition: t });
  });

  router.delete('/time-conditions/:id', id, async (req, res) => {
    try {
      const t = await store.deleteTimeCondition(req.valid.params.id);
      await record(req, 'pbx.time_condition.delete', t.name);
      changed('time_condition.delete');
      res.json({ status: 'deleted', name: t.name });
    } catch (err) {
      await record(req, 'pbx.time_condition.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // ------------------------------------------------------------------- prompts
  router.get('/prompts', async (_req, res) => {
    res.json({ prompts: await store.listPrompts() });
  });

  // The browser converts MP3 / recordings to WAV; the server accepts any PCM WAV and converts it to 8 kHz mono.
  router.post('/prompts', express.raw({ type: () => true, limit: '12mb' }), validate({ query: schemas.uploadPrompt }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Send the WAV file as the request body', 'bad_audio');
      const p = await store.createPrompt(req.valid.query.name, req.body);
      await record(req, 'pbx.prompt.create', p.name, { duration_ms: p.duration_ms, size_bytes: p.size_bytes });
      res.status(201).json({ prompt: p });
    } catch (err) {
      await record(req, 'pbx.prompt.create', req.valid.query?.name || 'upload', { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  router.get('/prompts/:id/audio', id, async (req, res) => {
    await store.getPrompt(req.valid.params.id);
    res.set({ 'Cache-Control': 'private, no-cache', 'Content-Type': 'audio/wav' });
    res.sendFile(store.promptFile(req.valid.params.id), (err) => { if (err && !res.headersSent) res.status(404).json({ error: { code: 'not_found', message: 'Audio file is missing' } }); });
  });

  router.patch('/prompts/:id', validate({ params: schemas.idParam, body: schemas.renamePrompt }), async (req, res) => {
    const p = await store.renamePrompt(req.valid.params.id, req.valid.body.name);
    await record(req, 'pbx.prompt.rename', p.name);
    res.json({ prompt: p });
  });

  router.delete('/prompts/:id', id, async (req, res) => {
    try {
      const p = await store.deletePrompt(req.valid.params.id);
      await record(req, 'pbx.prompt.delete', p.name);
      res.json({ status: 'deleted', name: p.name });
    } catch (err) {
      await record(req, 'pbx.prompt.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // ------------------------------------------------------------- announcements
  router.get('/announcements', async (_req, res) => {
    res.json({ announcements: await store.listAnnouncements() });
  });

  router.post('/announcements', validate({ body: schemas.createAnnouncement }), async (req, res) => {
    const a = await store.createAnnouncement(req.valid.body);
    await record(req, 'pbx.announcement.create', a.name, { prompt: a.prompt_name });
    changed('announcement.create');
    res.status(201).json({ announcement: a });
  });

  router.patch('/announcements/:id', validate({ params: schemas.idParam, body: schemas.patchAnnouncement }), async (req, res) => {
    const a = await store.updateAnnouncement(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.announcement.update', a.name, { fields: Object.keys(req.valid.body) });
    changed('announcement.update');
    res.json({ announcement: a });
  });

  router.delete('/announcements/:id', id, async (req, res) => {
    try {
      const a = await store.deleteAnnouncement(req.valid.params.id);
      await record(req, 'pbx.announcement.delete', a.name);
      changed('announcement.delete');
      res.json({ status: 'deleted', name: a.name });
    } catch (err) {
      await record(req, 'pbx.announcement.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // ---------------------------------------------------------------------- menus
  router.get('/ivrs', async (_req, res) => {
    res.json({ ivrs: await store.listIvrs() });
  });

  router.post('/ivrs', validate({ body: schemas.createIvr }), async (req, res) => {
    try {
      const i = await store.createIvr(req.valid.body);
      await record(req, 'pbx.ivr.create', i.number, { name: i.name, options: i.options.map((o) => o.digit) });
      changed('ivr.create');
      res.status(201).json({ ivr: i });
    } catch (err) {
      await record(req, 'pbx.ivr.create', req.valid.body.number, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  router.patch('/ivrs/:id', validate({ params: schemas.idParam, body: schemas.patchIvr }), async (req, res) => {
    const i = await store.updateIvr(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.ivr.update', i.number, { fields: Object.keys(req.valid.body) });
    changed('ivr.update');
    res.json({ ivr: i });
  });

  router.delete('/ivrs/:id', id, async (req, res) => {
    try {
      const i = await store.deleteIvr(req.valid.params.id);
      await record(req, 'pbx.ivr.delete', i.number);
      changed('ivr.delete');
      res.json({ status: 'deleted', number: i.number });
    } catch (err) {
      await record(req, 'pbx.ivr.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // ---------------------------------------------------------------------- queues
  router.get('/queues', async (_req, res) => {
    res.json({ queues: await store.listQueues() });
  });

  router.get('/queues/status', async (_req, res) => {
    res.json(await queueService.status());
  });

  router.get('/queues/stats', validate({ query: schemas.queueStatsQuery }), async (req, res) => {
    res.json(await queueService.stats(req.valid.query));
  });

  router.post('/queues', validate({ body: schemas.createQueue }), async (req, res) => {
    try {
      const q = await store.createQueue(req.valid.body);
      await record(req, 'pbx.queue.create', q.number, { name: q.name, strategy: q.strategy, members: q.members });
      changed('queue.create');
      res.status(201).json({ queue: q });
    } catch (err) {
      await record(req, 'pbx.queue.create', req.valid.body.number, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  router.patch('/queues/:id', validate({ params: schemas.idParam, body: schemas.patchQueue }), async (req, res) => {
    const q = await store.updateQueue(req.valid.params.id, req.valid.body);
    await record(req, 'pbx.queue.update', q.number, { fields: Object.keys(req.valid.body) });
    changed('queue.update');
    res.json({ queue: q });
  });

  router.delete('/queues/:id', id, async (req, res) => {
    try {
      const q = await store.deleteQueue(req.valid.params.id);
      await record(req, 'pbx.queue.delete', q.number);
      changed('queue.delete');
      res.json({ status: 'deleted', number: q.number });
    } catch (err) {
      await record(req, 'pbx.queue.delete', req.valid.params.id, { reason: err.code || 'error' }, 'failure');
      throw err;
    }
  });

  // --------------------------------------------------------------------- apply
  router.get('/apply', async (_req, res) => {
    res.json(applier.status());
  });

  router.post('/apply', async (req, res) => {
    const result = await applier.apply(`manual:${req.user.username}`, { force: true });
    await record(req, 'pbx.apply', 'manual', { ok: result.ok, error: result.error }, result.ok ? 'success' : 'failure');
    res.status(result.ok ? 200 : 502).json(result);
  });

  return router;
}

module.exports = { pbxRoutes };
