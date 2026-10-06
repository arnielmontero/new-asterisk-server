'use strict';
const express = require('express');
const { forbidden } = require('../errors');

/** Mounted behind authenticate (all roles may read status). */
function extensionRoutes({ state, registry, store, config }) {
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

  return router;
}

module.exports = { extensionRoutes };
