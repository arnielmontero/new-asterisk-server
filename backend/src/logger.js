'use strict';
const pino = require('pino');

// Secrets must never reach the logs, even by accident.
const REDACT = [
  'password', '*.password', 'newPassword', '*.newPassword',
  'secret', '*.secret', 'token', '*.token', 'pass', '*.pass',
  'password_hash', '*.password_hash',
  'req.headers.authorization', 'req.headers.cookie',
];

function createLogger(level = 'info', destination) {
  return pino(
    { level, redact: { paths: REDACT, censor: '[redacted]' }, base: { app: 'comms-backend' } },
    destination,
  );
}

module.exports = { createLogger };
