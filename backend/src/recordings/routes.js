'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');

const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const listQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  number: z.string().trim().min(1).max(40).regex(/^[0-9A-Za-z*#+._@-]+$/).optional(),
});

/** Mounted at /recordings behind authenticate + requireRole('admin'). Listening to and deleting a recording is audited. */
function recordingRoutes({ recordings, audit }) {
  const router = express.Router();
  const record = (req, action, target, details = null) =>
    audit.log({ user: req.user, action, target: String(target), ip: clientIp(req), details });

  router.get('/', validate({ query: listQuery }), async (req, res) => {
    res.json(await recordings.list(req.valid.query));
  });

  router.get('/:id/audio', validate({ params: idParam }), async (req, res) => {
    const rec = await recordings.get(req.valid.params.id);
    // A player asks for the same file several times (ranges while seeking): audit the start of a listen only.
    if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) await record(req, 'recording.play', rec.id, { src: rec.src, dst: rec.dst, started_at: rec.started_at });
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'audio/wav' });
    res.sendFile(recordings.file(rec.file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'not_found', message: 'The audio file is missing' } });
    });
  });

  router.delete('/:id', validate({ params: idParam }), async (req, res) => {
    const rec = await recordings.remove(req.valid.params.id);
    await record(req, 'recording.delete', rec.id, { src: rec.src, dst: rec.dst });
    res.json({ status: 'deleted' });
  });

  return router;
}

module.exports = { recordingRoutes };
