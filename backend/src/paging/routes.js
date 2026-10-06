'use strict';
const express = require('express');
const { schemas } = require('../validation/schemas');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');
const { badRequest } = require('../errors');

/** Mounted behind authenticate + requireRole('admin', 'operator'). */
function pagingRoutes({ paging, registry }) {
  const router = express.Router();

  // Authorise a page. The caller's own browser then places the SIP call to the
  // returned group number with its microphone; this never originates audio itself.
  router.post('/', validate({ body: schemas.page }), async (req, res) => {
    // Only existing, enabled groups can be paged; anything else is a malformed request, whoever asks.
    if (!registry.isPagingGroup(req.valid.body.group)) throw badRequest('That paging group does not exist or is disabled', 'unknown_group');
    const result = await paging.request(req.user, req.valid.body.group, clientIp(req));
    res.status(202).json({
      status: 'authorized',
      ...result,
      next: `Place a SIP call to ${result.group} from extension ${result.extension} within ${result.authorizedForSeconds} seconds`,
    });
  });

  router.get('/', (_req, res) => {
    res.json({ page: paging.current() });
  });

  router.delete('/', async (req, res) => {
    await paging.cancel(req.user, clientIp(req));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { pagingRoutes };
