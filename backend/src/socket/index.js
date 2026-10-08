'use strict';
const { Server } = require('socket.io');
const { parseCookie } = require('cookie');
const { COOKIE_NAME } = require('../auth/middleware');

/**
 * Real-time channel for the dashboard.
 *
 * Authenticated with the same HttpOnly session cookie (or a bearer token) as the
 * REST API. Unauthenticated connections are refused, so extension state is never
 * visible without logging in.
 *
 * Server -> client events (payloads are plain JSON):
 *   extension.snapshot        [{ extension, name, state, registered, clients }]   on connect
 *   extension.status.changed  { extension, name, state, registered, clients }
 *   call.started              { from, to }
 *   call.ended                { from, to, durationSeconds }
 *   paging.started            { group, name, extension, username, targets, status, startedAt }
 *   paging.ended              { group, name, extension, username, reason, durationSeconds }
 *   paging.failed             { group, name, extension, username, reason }
 *   voicemail.changed         { extension, kind: new|heard|deleted, id }   (owner of the box and administrators)
 *   conference.changed        { room }                                     (someone joined, left, was muted or the room was locked)
 *   ami.connected / ami.disconnected   { state, ... }          (administrators only)
 *   ami.snapshot              { state, ... }                    (administrators only, on connect)
 */
function createSocketServer({ httpServer, authService, state, paging, ami, registry, trunkStatus, applier, cdr, voicemail, conferenceService, logger }) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    // Same-origin deployment: no cross-origin access.
    cors: { origin: false },
    pingInterval: 10000,
    pingTimeout: 10000,
  });

  io.use(async (socket, next) => {
    try {
      const header = socket.handshake.headers.authorization;
      const cookies = parseCookie(socket.handshake.headers.cookie || '');
      // Browsers authenticate with the HttpOnly session cookie; API clients may send a
      // bearer header or the handshake `auth: { token }` payload.
      const handshakeToken = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
      const token = header && /^Bearer\s+\S+$/i.test(header)
        ? header.replace(/^Bearer\s+/i, '')
        : handshakeToken || cookies[COOKIE_NAME];
      const result = await authService.authenticateToken(token);
      if (!result) return next(new Error('unauthorized'));
      socket.data.user = result.user;
      return next();
    } catch (err) {
      logger.warn({ err: err.message }, 'socket authentication error');
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(`user:${user.id}`);
    if (user.extension) socket.join(`ext:${user.extension}`);
    socket.emit('extension.snapshot', state.snapshot());
    if (user.role === 'admin') {
      socket.join('admins');
      socket.emit('ami.snapshot', ami.status());
      socket.emit('trunk.snapshot', trunkStatus.snapshot());
      socket.emit('pbx.apply', applier.status());
    }
    const current = paging.current();
    if (current && current.status === 'live') socket.emit('paging.started', current);
  });

  // The extension plan changed (create/delete/rename): everyone gets a fresh list.
  registry.on('changed', () => io.emit('extension.snapshot', state.snapshot()));
  trunkStatus.on('change', (list) => io.to('admins').emit('trunk.snapshot', list));
  applier.on('applied', () => io.to('admins').emit('pbx.apply', applier.status()));
  applier.on('failed', () => io.to('admins').emit('pbx.apply', applier.status()));
  // A message arrived, was heard or deleted: the owner's open dashboards (and administrators) refresh.
  if (voicemail) voicemail.onChange = (m) => io.to(`ext:${m.extension}`).to('admins').emit('voicemail.changed', m);
  if (conferenceService) conferenceService.onChange = (c) => io.emit('conference.changed', c);
  if (cdr) cdr.onRecord = (r) => io.to('admins').emit('cdr.new', r);
  state.on('change', (ext) => io.emit('extension.status.changed', ext));
  state.on('call.started', (c) => io.emit('call.started', c));
  state.on('call.ended', (c) => io.emit('call.ended', c));
  paging.on('started', (p) => io.emit('paging.started', p));
  paging.on('ended', (p) => io.emit('paging.ended', p));
  paging.on('failed', (p) => io.emit('paging.failed', p));
  ami.on('connected', () => io.to('admins').emit('ami.connected', ami.status()));
  ami.on('disconnected', () => io.to('admins').emit('ami.disconnected', ami.status()));

  /** Drop live sockets of a user whose role/status/password changed or who was deleted. */
  const disconnectUser = (userId) => io.in(`user:${userId}`).disconnectSockets(true);

  return { io, disconnectUser };
}

module.exports = { createSocketServer };
