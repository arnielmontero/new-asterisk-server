'use strict';
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { schemas } = require('../validation/schemas');
const { validate } = require('../validation/middleware');
const { authenticate, clientIp, COOKIE_NAME } = require('./middleware');

function cookieOptions(config, maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeMs,
  };
}

function authRoutes({ config, authService, audit }) {
  const router = express.Router();

  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimit.windowSeconds * 1000,
    limit: config.loginRateLimit.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip || '')}:${String(req.body?.username || '').toLowerCase().slice(0, 64)}`,
    handler: async (req, res) => {
      await audit.log({
        username: String(req.body?.username || '').slice(0, 64).toLowerCase() || null,
        action: 'auth.login',
        ip: clientIp(req),
        status: 'failure',
        details: { reason: 'rate_limited' },
      });
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many login attempts. Try again later.' } });
    },
  });

  router.post('/login', loginLimiter, validate({ body: schemas.login }), async (req, res) => {
    const { username, password } = req.valid.body;
    const { user, token, expiresAt } = await authService.login(username, password, clientIp(req));
    res.cookie(COOKIE_NAME, token, cookieOptions(config, config.jwt.accessTtlSeconds * 1000));
    // The SPA relies on the HttpOnly cookie and never stores this token; it is returned for non-browser API clients.
    res.json({ user, token, expiresAt });
  });

  router.post('/logout', authenticate(authService), async (req, res) => {
    await audit.log({ user: req.user, action: 'auth.logout', ip: clientIp(req) });
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  router.get('/me', authenticate(authService), (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/refresh', authenticate(authService), (req, res) => {
    const { token, expiresAt } = authService.refresh(req.user, req.claims);
    res.cookie(COOKIE_NAME, token, cookieOptions(config, config.jwt.accessTtlSeconds * 1000));
    res.json({ user: req.user, expiresAt });
  });

  return router;
}

module.exports = { authRoutes };
