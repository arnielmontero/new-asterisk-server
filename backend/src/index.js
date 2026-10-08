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
const { PbxRegistry } = require('./extensions/registry');
const { PbxStore } = require('./pbx/store');
const { ConfigApplier } = require('./pbx/apply');
const { TrunkStatus } = require('./pbx/trunk-status');
const { CdrService } = require('./cdr/service');
const { QueueService } = require('./queues/service');
const { VoicemailService } = require('./voicemail/service');
const { ConferenceService } = require('./conferences/service');
const { ParkingService } = require('./parking/service');
const { RecordingService } = require('./recordings/service');
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

  const store = new PbxStore(db, { mediaDir: config.pbxMediaDir });
  const filled = await store.fillMissingSecrets(config.seedSecrets);
  if (filled) logger.info({ extensions: filled }, 'initial extension credentials set');
  const registry = new PbxRegistry();
  registry.load(await store.snapshot());

  const ami = new AmiClient({ ...config.ami, logger });
  const state = new ExtensionState({ ami, registry, logger });
  const trunkStatus = new TrunkStatus({ ami, registry, logger });
  const applier = new ConfigApplier({
    store, registry, ami, db, logger, dir: config.pbxGeneratedDir,
    onReloaded: async () => { await state.sync(); await trunkStatus.refresh(); },
  });
  const cdr = new CdrService({ db, registry, ami, logger });
  const queueService = new QueueService({ ami, db, logger });
  const conferenceService = new ConferenceService({ ami, registry, logger });
  const parking = new ParkingService({ ami, registry, logger });
  const voicemail = new VoicemailService({ db, ami, logger, dir: path.join(config.pbxMediaDir, 'voicemail') });
  const recordings = new RecordingService({ db, ami, logger, dir: path.join(config.pbxMediaDir, 'recordings') });
  const paging = new PagingService({ ami, state, registry, audit, logger });
  watchOriginateResults({ ami, audit });

  let socketApi = null;
  const app = createApp({
    config, logger, db, users, audit, authService, ami, state, paging, registry, store, applier, trunkStatus, cdr, queueService, conferenceService, parking, voicemail, recordings,
    version: pkg.version,
    startedAt,
    onUserSecurityChange: (userId) => socketApi?.disconnectUser(userId),
  });
  const server = http.createServer(app);
  socketApi = createSocketServer({ httpServer: server, authService, state, paging, ami, registry, trunkStatus, applier, cdr, voicemail, conferenceService, parking, logger });

  // Write the generated configuration before Asterisk is asked to load it; a reload follows once AMI connects.
  await applier.apply('startup', { force: true });
  trunkStatus.start();
  // Call-record retention (CDR_RETENTION_DAYS, 0 = keep forever): checked hourly.
  let pruneTimer = null;
  if (config.cdrRetentionDays > 0) {
    const prune = () => cdr.prune(config.cdrRetentionDays).then((n) => n && logger.info({ removed: n }, 'old call records removed')).catch((err) => logger.warn({ err: err.message }, 'call record pruning failed'));
    prune();
    pruneTimer = setInterval(prune, 3600 * 1000);
    pruneTimer.unref?.();
  }
  // Recordings and voicemail: retention (0 = keep forever), and recordings whose end was never reported are closed.
  const media = () => {
    recordings.sweep().catch((err) => logger.warn({ err: err.message }, 'recording sweep failed'));
    if (config.recordingRetentionDays > 0) recordings.prune(config.recordingRetentionDays).then((n) => n && logger.info({ removed: n }, 'old recordings removed')).catch((err) => logger.warn({ err: err.message }, 'recording pruning failed'));
    if (config.voicemailRetentionDays > 0) voicemail.prune(config.voicemailRetentionDays).then((n) => n && logger.info({ removed: n }, 'old voicemail removed')).catch((err) => logger.warn({ err: err.message }, 'voicemail pruning failed'));
  };
  recordings.init().catch((err) => logger.warn({ err: err.message }, 'could not resume recordings'));
  media();
  const mediaTimer = setInterval(media, 3600 * 1000);
  mediaTimer.unref?.();
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
      trunkStatus.stop();
      clearInterval(pruneTimer);
      clearInterval(mediaTimer);
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
