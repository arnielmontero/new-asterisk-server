'use strict';
const express = require('express');
const { schemas } = require('../validation/schemas');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');

/** Mounted behind authenticate + requireRole('admin'). */
function userRoutes({ users, audit, onUserSecurityChange }) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    res.json({ users: await users.list() });
  });

  router.post('/', validate({ body: schemas.createUser }), async (req, res) => {
    try {
      const created = await users.create(req.valid.body);
      await audit.log({
        user: req.user,
        action: 'user.create',
        target: created.username,
        ip: clientIp(req),
        details: { role: created.role, extension: created.extension, is_active: created.is_active },
      });
      res.status(201).json({ user: created });
    } catch (err) {
      await audit.log({ user: req.user, action: 'user.create', target: req.valid.body.username, ip: clientIp(req), status: 'failure', details: { reason: err.code || 'error' } });
      throw err;
    }
  });

  router.patch('/:id', validate({ params: schemas.idParam, body: schemas.patchUser }), async (req, res) => {
    const { id } = req.valid.params;
    try {
      const { user, changes } = await users.update(id, req.valid.body);
      await audit.log({
        user: req.user,
        action: 'user.update',
        target: user.username,
        ip: clientIp(req),
        details: { changed: changes },
      });
      // Role / status / password changes invalidate sessions: drop live sockets too.
      if (changes.some((c) => c !== 'extension')) onUserSecurityChange?.(user.id);
      res.json({ user });
    } catch (err) {
      await audit.log({ user: req.user, action: 'user.update', target: String(id), ip: clientIp(req), status: 'failure', details: { reason: err.code || 'error' } });
      throw err;
    }
  });

  router.delete('/:id', validate({ params: schemas.idParam }), async (req, res) => {
    const { id } = req.valid.params;
    try {
      const removed = await users.remove(id);
      await audit.log({ user: req.user, action: 'user.delete', target: removed.username, ip: clientIp(req) });
      onUserSecurityChange?.(removed.id);
      res.json({ ok: true });
    } catch (err) {
      await audit.log({ user: req.user, action: 'user.delete', target: String(id), ip: clientIp(req), status: 'failure', details: { reason: err.code || 'error' } });
      throw err;
    }
  });

  return router;
}

module.exports = { userRoutes };
