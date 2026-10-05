'use strict';
const { unauthorized, forbidden } = require('../errors');

const COOKIE_NAME = 'session';

function tokenFromRequest(req) {
  const header = req.headers.authorization;
  if (header && /^Bearer\s+\S+$/i.test(header)) return header.replace(/^Bearer\s+/i, '');
  return req.cookies?.[COOKIE_NAME] || null;
}

/** Require a valid session. Sets req.user and req.claims. */
function authenticate(authService) {
  return async (req, _res, next) => {
    try {
      const result = await authService.authenticateToken(tokenFromRequest(req));
      if (!result) return next(unauthorized());
      req.user = result.user;
      req.claims = result.claims;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Authorization is enforced here, on the server, regardless of what the UI shows. */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    return next();
  };
}

/**
 * Cookie-authenticated, state-changing requests must come from our own origin.
 * (SameSite=Strict already blocks cross-site cookies; this is defence in depth.)
 */
function sameOriginForWrites(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return next(forbidden('Cross-origin request rejected', 'bad_origin'));
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (originHost !== host) return next(forbidden('Cross-origin request rejected', 'bad_origin'));
  return next();
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

module.exports = { COOKIE_NAME, tokenFromRequest, authenticate, requireRole, sameOriginForWrites, clientIp };
