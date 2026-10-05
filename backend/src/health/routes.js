'use strict';
const express = require('express');

/**
 * /health/live  - the process is up (never touches dependencies)
 * /health, /health/ready - the service can actually do its job:
 *      database reachable AND Asterisk AMI connected.
 *   200 only when everything works; 503 when a dependency is down, so a running
 *   backend with no telephony is never reported as healthy.
 */
function healthRoutes({ db, ami }) {
  const router = express.Router();

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const ready = async (_req, res) => {
    const dbOk = await db.ping();
    const amiOk = ami.isConnected();
    const status = dbOk && amiOk ? 'ok' : dbOk ? 'degraded' : 'down';
    res.status(status === 'ok' ? 200 : 503).json({
      status,
      checks: {
        application: 'ok',
        database: dbOk ? 'ok' : 'down',
        ami: amiOk ? 'connected' : ami.state,
      },
    });
  };
  router.get('/', ready);
  router.get('/ready', ready);

  return router;
}

module.exports = { healthRoutes };
