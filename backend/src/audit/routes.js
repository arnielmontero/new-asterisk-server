'use strict';
const express = require('express');
const { schemas } = require('../validation/schemas');
const { validate } = require('../validation/middleware');

/** Read-only. Mounted behind authenticate + requireRole('admin'). There is no write path. */
function auditRoutes({ audit }) {
  const router = express.Router();

  router.get('/', validate({ query: schemas.auditQuery }), async (req, res) => {
    res.json(await audit.list(req.valid.query));
  });

  return router;
}

module.exports = { auditRoutes };
