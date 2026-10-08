'use strict';
const express = require('express');
const { z } = require('zod');
const { forbidden } = require('../errors');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');

const idParam = z.strictObject({ id: z.coerce.number().int().positive() });
const listQuery = z.strictObject({ extension: z.string().regex(/^\d{3,6}$/).optional(), unread: z.enum(['true', 'false']).optional() });
const heardBody = z.strictObject({ heard: z.boolean() });

/**
 * Mounted behind authenticate. People manage the messages of their own extension (operators and administrators);
 * administrators manage everyone's. Listening, marking and deleting are audited.
 */
function voicemailRoutes({ voicemail, audit }) {
  const router = express.Router();

  const mayUse = (user, extension) => user.role === 'admin' || (user.role === 'operator' && !!user.extension && user.extension === extension);

  const record = (req, action, target, details = null) =>
    audit.log({ user: req.user, action, target: String(target), ip: clientIp(req), details });

  router.get('/voicemail', validate({ query: listQuery }), async (req, res) => {
    const { user } = req;
    const { extension, unread } = req.valid.query;
    if (user.role === 'admin') {
      res.json({ messages: await voicemail.list({ extension: extension || null, unread: unread === 'true' }), unread: await voicemail.unreadCounts() });
      return;
    }
    if (!mayUse(user, user.extension)) throw forbidden('You have no voicemail box');
    const messages = await voicemail.list({ extension: user.extension, unread: unread === 'true' });
    res.json({ messages, unread: { [user.extension]: (await voicemail.unreadCounts())[user.extension] || 0 } });
  });

  const load = async (req) => {
    const msg = await voicemail.get(req.valid.params.id);
    if (!mayUse(req.user, msg.extension)) throw forbidden('That message is not in your voicemail box');
    return msg;
  };

  router.get('/voicemail/:id/audio', validate({ params: idParam }), async (req, res) => {
    const msg = await load(req);
    await record(req, 'voicemail.play', msg.extension, { id: msg.id });
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'audio/wav' });
    res.sendFile(voicemail.file(msg.file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'not_found', message: 'The audio file is missing' } });
    });
  });

  router.patch('/voicemail/:id', validate({ params: idParam, body: heardBody }), async (req, res) => {
    await load(req);
    res.json({ message: await voicemail.markHeard(req.valid.params.id, req.valid.body.heard) });
  });

  router.delete('/voicemail/:id', validate({ params: idParam }), async (req, res) => {
    const msg = await load(req);
    await voicemail.remove(msg.id);
    await record(req, 'voicemail.delete', msg.extension, { id: msg.id, caller: msg.caller });
    res.json({ status: 'deleted' });
  });

  return router;
}

module.exports = { voicemailRoutes };
