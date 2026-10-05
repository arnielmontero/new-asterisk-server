'use strict';
const jwt = require('jsonwebtoken');
const { unauthorized } = require('../errors');

const ALG = 'HS256';

class AuthService {
  constructor({ config, users, audit, logger }) {
    this.config = config;
    this.users = users;
    this.audit = audit;
    this.logger = logger;
  }

  /**
   * Sign a short-lived access token. `sessionStart` (epoch seconds) is carried
   * across refreshes so a session has an absolute maximum lifetime.
   * Role is deliberately NOT in the token: it is read from the database on every request.
   */
  issueToken(user, sessionStart = Math.floor(Date.now() / 1000)) {
    const { secret, issuer, audience, accessTtlSeconds } = this.config.jwt;
    const token = jwt.sign({ tv: user.token_version, st: sessionStart }, secret, {
      algorithm: ALG,
      subject: String(user.id),
      issuer,
      audience,
      expiresIn: accessTtlSeconds,
    });
    return { token, expiresAt: new Date(Date.now() + accessTtlSeconds * 1000) };
  }

  /** Verify signature, expiry, issuer and audience. Returns claims or null. */
  verifyToken(token) {
    const { secret, issuer, audience } = this.config.jwt;
    try {
      return jwt.verify(token, secret, { algorithms: [ALG], issuer, audience });
    } catch {
      return null;
    }
  }

  /** Resolve a token to a live, active user whose token_version still matches. */
  async authenticateToken(token) {
    if (!token) return null;
    const claims = this.verifyToken(token);
    if (!claims) return null;
    const sessionAge = Math.floor(Date.now() / 1000) - Number(claims.st);
    if (!Number.isFinite(sessionAge) || sessionAge > this.config.jwt.sessionMaxSeconds) return null;
    const user = await this.users.findAuthById(Number(claims.sub));
    if (!user || !user.is_active || user.token_version !== claims.tv) return null;
    return { user: this.sanitize(user), claims };
  }

  sanitize(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      extension: user.extension,
      is_active: user.is_active,
    };
  }

  async login(username, password, ip) {
    const { user, reason } = await this.users.verifyCredentials(username.trim().toLowerCase(), password);
    if (!user) {
      await this.audit.log({ username: username.slice(0, 64).toLowerCase(), action: 'auth.login', ip, status: 'failure', details: { reason } });
      this.logger.warn({ username: username.slice(0, 64), ip, reason }, 'login failed');
      throw unauthorized('Invalid username or password', 'invalid_credentials');
    }
    const session = this.issueToken(user);
    const safe = this.sanitize(user);
    await this.audit.log({ user: safe, action: 'auth.login', ip, status: 'success' });
    return { user: safe, ...session };
  }

  /** Re-issue a token for a still-valid session (sliding window, capped by sessionMaxSeconds). */
  refresh(user, claims) {
    return this.issueToken({ ...user, token_version: claims.tv }, claims.st);
  }
}

module.exports = { AuthService };
