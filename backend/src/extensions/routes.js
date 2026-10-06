'use strict';
const express = require('express');
const { z } = require('zod');
const { forbidden } = require('../errors');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');
const { destinationSchema } = require('../pbx/destinations');

// What a person may change about their own extension (nothing about credentials, numbers or outbound permission).
const mySettings = z.strictObject({
  dnd: z.boolean().optional(),
  fwd_all: destinationSchema.nullable().optional(),
  fwd_busy: destinationSchema.nullable().optional(),
  fwd_noanswer: destinationSchema.nullable().optional(),
  noanswer_secs: z.coerce.number().int().min(5).max(120).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

/** Mounted behind authenticate (all roles may read status). */
function extensionRoutes({ state, registry, store, config, applier, audit }) {
  const router = express.Router();

  const pagingGroups = () => registry.pagingGroups().map((g) => ({ number: g.number, name: g.name, members: g.members }));

  router.get('/extensions', (_req, res) => {
    res.json({
      extensions: state.snapshot(),
      pagingGroups: pagingGroups(),
      echoExtension: registry.echoExtension,
    });
  });

  // SIP credentials for the caller's own browser softphone. Only operators and
  // administrators with an assigned extension receive them; the password is
  // inherently visible to that browser session, so it is only served over HTTPS
  // to the authenticated owner and never logged.
  router.get('/sip/config', async (req, res) => {
    const { user } = req;
    if (!['admin', 'operator'].includes(user.role)) throw forbidden('Your role does not have a softphone');
    const ext = user.extension ? registry.extension(user.extension) : null;
    if (!ext) {
      res.json({ configured: false, reason: 'No SIP extension is assigned to your account' });
      return;
    }
    if (!ext.webrtc) {
      res.json({ configured: false, reason: `Extension ${ext.number} has no browser softphone enabled` });
      return;
    }
    const secrets = await store.getExtensionSecretsByNumber(ext.number);
    res.set('Cache-Control', 'no-store');
    res.json({
      configured: true,
      extension: ext.number,
      displayName: ext.name,
      username: ext.number,
      password: secrets.secret,
      domain: config.serverHostname,
      echoExtension: registry.echoExtension,
      pagingGroups: registry.pagingGroups().map((g) => g.number),
    });
  });

  // Do not disturb and forwarding for the caller's own extension (operators and administrators).
  router.get('/my/extension', async (req, res) => {
    const { user } = req;
    if (!['admin', 'operator'].includes(user.role) || !user.extension) throw forbidden('You have no extension');
    const ext = (await store.listExtensions()).find((e) => e.number === user.extension);
    res.json({ extension: ext ? { number: ext.number, display_name: ext.display_name, dnd: ext.dnd, fwd_all: ext.fwd_all, fwd_busy: ext.fwd_busy, fwd_noanswer: ext.fwd_noanswer, noanswer_secs: ext.noanswer_secs } : null });
  });

  router.patch('/my/extension', validate({ body: mySettings }), async (req, res) => {
    const { user } = req;
    if (!['admin', 'operator'].includes(user.role) || !user.extension) throw forbidden('You have no extension');
    const row = (await store.listExtensions()).find((e) => e.number === user.extension);
    const ext = await store.updateExtension(row.id, req.valid.body);
    await audit.log({ user, action: 'extension.self.update', target: ext.number, ip: clientIp(req), details: { fields: Object.keys(req.valid.body), dnd: ext.dnd } });
    applier.schedule('extension.self');
    res.json({ extension: { number: ext.number, dnd: ext.dnd, fwd_all: ext.fwd_all, fwd_busy: ext.fwd_busy, fwd_noanswer: ext.fwd_noanswer, noanswer_secs: ext.noanswer_secs } });
  });

  return router;
}

module.exports = { extensionRoutes };
