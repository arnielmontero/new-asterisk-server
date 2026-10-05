'use strict';
const express = require('express');
const { schemas } = require('../validation/schemas');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');
const { HttpError, conflict } = require('../errors');
const { EXTENSIONS } = require('../extensions/registry');

/** Mounted behind authenticate + requireRole('admin', 'operator'). */
function callRoutes({ ami, state, audit, logger }) {
  const router = express.Router();

  // Only configured extensions are accepted (schema enum), and the AMI action is
  // fixed: no caller-controlled channel, context, application or dial string.
  router.post('/originate', validate({ body: schemas.originate }), async (req, res) => {
    const { from, to } = req.valid.body;
    const auditFail = (reason, status = 'failure') =>
      audit.log({ user: req.user, action: 'call.originate', target: `${from}->${to}`, ip: clientIp(req), status, details: { reason } });

    if (!ami.isConnected()) {
      await auditFail('ami_unavailable');
      throw new HttpError(503, 'ami_unavailable', 'The telephony system is unavailable');
    }
    const source = state.get(from);
    const dest = state.get(to);
    if (!source.registered) {
      await auditFail('source_offline');
      throw conflict(`Extension ${from} (${source.name}) is offline`, 'source_offline');
    }
    if (!dest.registered) {
      await auditFail('destination_offline');
      throw conflict(`Extension ${to} (${dest.name}) is offline`, 'destination_offline');
    }
    if (source.state === 'In-Call' || source.state === 'Paging') {
      await auditFail('source_busy');
      throw conflict(`Extension ${from} (${source.name}) is busy`, 'source_busy');
    }

    try {
      // Rings the "from" extension (browser and phone); when answered it is connected to "to".
      const result = await ami.action({
        Action: 'Originate',
        Channel: `Local/${from}@originate-leg/n`,
        Context: 'default',
        Exten: to,
        Priority: '1',
        CallerID: `"${EXTENSIONS[from].name}" <${from}>`,
        Timeout: '30000',
        Async: 'true',
      });
      if (result.response !== 'Success') throw new Error(result.message || 'Originate refused');
    } catch (err) {
      logger.error({ err: err.message, from, to }, 'originate failed');
      await auditFail('ami_error');
      throw new HttpError(502, 'ami_error', 'The telephony system could not start the call');
    }

    await audit.log({ user: req.user, action: 'call.originate', target: `${from}->${to}`, ip: clientIp(req), details: { from, to } });
    logger.info({ user: req.user.username, from, to }, 'call originate queued');
    res.status(202).json({ status: 'queued', from, to, message: `Ringing ${EXTENSIONS[from].name}; answer to be connected to ${EXTENSIONS[to].name}` });
  });

  // Hang up the live channels of one configured extension.
  router.post('/hangup', validate({ body: schemas.hangup }), async (req, res) => {
    const { extension } = req.valid.body;
    const channels = state.channelsFor(extension);
    if (channels.length === 0) {
      await audit.log({ user: req.user, action: 'call.hangup', target: extension, ip: clientIp(req), status: 'failure', details: { reason: 'no_active_call' } });
      throw conflict(`Extension ${extension} has no active call`, 'no_active_call');
    }
    let hungUp = 0;
    for (const channel of channels) {
      try {
        const r = await ami.action({ Action: 'Hangup', Channel: channel, Cause: '16' });
        if (r.response === 'Success') hungUp += 1;
      } catch (err) {
        logger.warn({ err: err.message, channel }, 'hangup failed');
      }
    }
    await audit.log({
      user: req.user,
      action: 'call.hangup',
      target: extension,
      ip: clientIp(req),
      status: hungUp ? 'success' : 'failure',
      details: { channels: channels.length, hungUp },
    });
    if (!hungUp) throw new HttpError(502, 'ami_error', 'The telephony system could not hang up the call');
    res.json({ status: 'hung_up', extension, channels: hungUp });
  });

  return router;
}

/** Audit the asynchronous result of originates we started (answered / no answer / failed). */
function watchOriginateResults({ ami, audit }) {
  ami.on('event', (evt) => {
    if (evt.Event !== 'OriginateResponse' || !String(evt.Channel || '').includes('@originate-leg')) return;
    const m = /^Local\/(\d{4})@originate-leg/.exec(evt.Channel);
    const from = m ? m[1] : null;
    const ok = evt.Response === 'Success';
    audit
      .log({
        username: null,
        action: 'call.originate.result',
        target: `${from}->${evt.Exten}`,
        status: ok ? 'success' : 'failure',
        details: { response: evt.Response, reason: evt.Reason },
      })
      .catch(() => {});
  });
}

module.exports = { callRoutes, watchOriginateResults };
