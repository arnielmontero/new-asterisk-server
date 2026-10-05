'use strict';
const http = require('node:http');
const path = require('node:path');

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { Database } = require('./db');
const { UsersService } = require('./users/service');
const { AuditService } = require('./audit/service');
const { AuthService } = require('./auth/service');
const { AmiClient } = require('./ami/client');
const { ExtensionState } = require('./extensions/state');
const { PagingService } = require('./paging/service');
const { watchOriginateResults } = require('./calls/routes');
const { createSocketServer } = require('./socket');
const { createApp } = require('./app');
const pkg = require('../package.json');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Logger is not configured yet; print the (value-free) reason and stop.
    console.error(err.message);
    process.exit(1);
  }
  const logger = createLogger(config.logLevel);
  const startedAt = Date.now();
  logger.info({ version: pkg.version, node: process.version }, 'starting');

  const db = new Database(config.db, logger);
  await db.connectWithRetry();
  await db.migrate(path.join(__dirname, '..', 'migrations'));

  const users = new UsersService(db);
  const audit = new AuditService(db, logger);
  const authService = new AuthService({ config, users, audit, logger });

  const boot = await users.ensureAdmin(config.adminPassword);
  if (boot.created) {
    await audit.log({ username: 'admin', action: 'admin.bootstrap', target: 'admin', details: { source: 'ADMIN_PASSWORD' } });
    logger.info('initial administrator "admin" created from ADMIN_PASSWORD');
  } else {
    logger.info('administrator already exists; ADMIN_PASSWORD not applied');
  }

  const ami = new AmiClient({ ...config.ami, logger });
  const state = new ExtensionState({ ami, logger });
  const paging = new PagingService({ ami, state, audit, logger });
  watchOriginateResults({ ami, audit });

  let socketApi = null;
  const app = createApp({
    config, logger, db, users, audit, authService, ami, state, paging,
    version: pkg.version,
    startedAt,
    onUserSecurityChange: (userId) => socketApi?.disconnectUser(userId),
  });
  const server = http.createServer(app);
  socketApi = createSocketServer({ httpServer: server, authService, state, paging, ami, logger });

  ami.start(); // reconnects on its own; the HTTP API stays up while Asterisk is away
  await new Promise((resolve) => server.listen(config.port, '0.0.0.0', resolve));
  logger.info({ port: config.port }, 'listening');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 10000);
    force.unref();
    try {
      // Stop accepting new requests, then drop the live Socket.IO/keep-alive connections: server.close()
      // alone only resolves once every connection has ended, which never happens while browsers are connected.
      const httpClosed = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      await new Promise((resolve) => socketApi.io.close(() => resolve()));
      server.closeAllConnections?.();
      await httpClosed;
      await ami.stop();
      await db.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err: String(err) }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('fatal startup error:', err.message);
  process.exit(1);
});
