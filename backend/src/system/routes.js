'use strict';
const express = require('express');

/** Mounted behind authenticate + requireRole('admin'). */
function systemRoutes({ db, ami, state, paging, version, startedAt }) {
  const router = express.Router();

  router.get('/status', async (_req, res) => {
    const dbOk = await db.ping();
    let asterisk = null;
    if (ami.isConnected()) {
      try {
        const v = await ami.action({ Action: 'Command', Command: 'core show version' });
        const u = await ami.action({ Action: 'Command', Command: 'core show uptime seconds' });
        asterisk = {
          version: String(v.fields?.Output || '').split('\n')[0] || null,
          uptimeSeconds: Number((/System uptime:\s*(\d+)/.exec(String(u.fields?.Output || '')) || [])[1]) || null,
        };
      } catch {
        asterisk = null;
      }
    }
    res.json({
      backend: { version, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
      database: { status: dbOk ? 'ok' : 'down' },
      ami: ami.status(),
      asterisk,
      extensions: state.snapshot(),
      page: paging.current(),
    });
  });

  return router;
}

module.exports = { systemRoutes };
