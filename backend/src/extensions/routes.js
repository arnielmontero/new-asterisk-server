'use strict';
const express = require('express');
const { forbidden } = require('../errors');
const { EXTENSIONS, PAGING_GROUPS, ECHO_EXTENSION } = require('./registry');

/** Mounted behind authenticate (all roles may read status). */
function extensionRoutes({ state, config, audit }) {
  const router = express.Router();

  router.get('/extensions', (_req, res) => {
    res.json({
      extensions: state.snapshot(),
      pagingGroups: Object.values(PAGING_GROUPS).map((g) => ({ number: g.number, name: g.name, members: g.members })),
      echoExtension: ECHO_EXTENSION,
    });
  });

  // SIP credentials for the caller's own browser softphone. Only operators and
  // administrators with an assigned extension receive them; the password is
  // inherently visible to that browser session, so it is only served over HTTPS
  // to the authenticated owner and never logged.
  router.get('/sip/config', async (req, res) => {
    const { user } = req;
    if (!['admin', 'operator'].includes(user.role)) throw forbidden('Your role does not have a softphone');
    if (!user.extension) {
      res.json({ configured: false, reason: 'No SIP extension is assigned to your account' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      configured: true,
      extension: user.extension,
      displayName: EXTENSIONS[user.extension].name,
      username: user.extension,
      password: config.extensionPasswords[user.extension],
      domain: config.serverHostname,
      echoExtension: ECHO_EXTENSION,
      pagingGroups: Object.values(PAGING_GROUPS).map((g) => g.number),
    });
  });

  return router;
}

module.exports = { extensionRoutes };
