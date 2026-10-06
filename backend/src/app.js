'use strict';
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const { HttpError, notFound } = require('./errors');
const { authenticate, requireRole, sameOriginForWrites, clientIp } = require('./auth/middleware');
const { authRoutes } = require('./auth/routes');
const { userRoutes } = require('./users/routes');
const { auditRoutes } = require('./audit/routes');
const { extensionRoutes } = require('./extensions/routes');
const { callRoutes } = require('./calls/routes');
const { pagingRoutes } = require('./paging/routes');
const { healthRoutes } = require('./health/routes');
const { systemRoutes } = require('./system/routes');
const { pbxRoutes } = require('./pbx/routes');
const { cdrRoutes } = require('./cdr/routes');

/**
 * Build the Express application from already-constructed services, so tests can
 * inject a fake AMI while production wires the real one.
 */
function createApp(deps) {
  const { config, logger, db, users, audit, authService, ami, state, paging, registry, store, applier, trunkStatus, cdr, queueService, version, startedAt, onUserSecurityChange } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // exactly one hop: the Nginx container
  app.use(helmet());

  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.originalUrl.startsWith('/health') || req.originalUrl.startsWith('/api/health')) return;
      logger.info(
        { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Number((process.hrtime.bigint() - start) / 1000000n), user: req.user?.username },
        'request',
      );
    });
    next();
  });

  app.use(express.json({ limit: '10kb', strict: true }));
  app.use(cookieParser());

  app.use('/health', healthRoutes({ db, ami }));

  const api = express.Router();
  api.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(req.ip || ''),
      handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } }),
    }),
  );
  api.use(sameOriginForWrites);
  api.use('/health', healthRoutes({ db, ami }));
  api.use('/auth', authRoutes({ config, authService, audit }));

  const auth = authenticate(authService);
  api.use(auth);

  api.use(extensionRoutes({ state, registry, store, config, applier, audit, queueService }));
  api.use('/users', requireRole('admin'), userRoutes({ users, audit, onUserSecurityChange }));
  api.use('/audit', requireRole('admin'), auditRoutes({ audit }));
  api.use('/system', requireRole('admin'), systemRoutes({ db, ami, state, paging, applier, trunkStatus, version, startedAt }));
  api.use('/pbx', requireRole('admin'), pbxRoutes({ store, applier, trunkStatus, queueService, audit, config }));
  api.use('/cdr', requireRole('admin'), cdrRoutes({ cdr, audit }));
  api.use(['/originate', '/hangup'], requireRole('admin', 'operator'));
  api.use(callRoutes({ ami, state, registry, audit, logger }));
  api.use('/page', requireRole('admin', 'operator'), pagingRoutes({ paging, registry }));
  api.use((_req, _res, next) => next(notFound('Unknown API endpoint')));

  app.use('/api', api);
  app.use((_req, _res, next) => next(notFound()));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    // Full detail stays in the server log; the client only gets a generic message.
    logger.error({ err: err?.message, stack: err?.stack, path: req.path, ip: clientIp(req) }, 'unhandled error');
    return res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  return app;
}

module.exports = { createApp };
