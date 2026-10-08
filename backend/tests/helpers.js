'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const request = require('supertest');

const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { Database } = require('../src/db');
const { UsersService } = require('../src/users/service');
const { AuditService } = require('../src/audit/service');
const { AuthService } = require('../src/auth/service');
const { ExtensionState } = require('../src/extensions/state');
const { PbxRegistry } = require('../src/extensions/registry');
const { PbxStore } = require('../src/pbx/store');
const { ConfigApplier } = require('../src/pbx/apply');
const { TrunkStatus } = require('../src/pbx/trunk-status');
const { CdrService } = require('../src/cdr/service');
const { QueueService } = require('../src/queues/service');
const { VoicemailService } = require('../src/voicemail/service');
const { ConferenceService } = require('../src/conferences/service');
const { RecordingService } = require('../src/recordings/service');
const { PagingService } = require('../src/paging/service');
const { createApp } = require('../src/app');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

/**
 * Scripted stand-in for Asterisk's AMI. Used ONLY by unit/integration tests;
 * production always uses the real AmiClient.
 */
class FakeAmi extends EventEmitter {
  constructor() {
    super();
    this.state = 'connected';
    this.calls = [];
    this.responses = new Map(); // Action name -> function(fields) | object
  }

  isConnected() { return this.state === 'connected'; }

  status() { return { state: this.state, host: 'fake', port: 5038 }; }

  async action(fields) {
    this.calls.push(fields);
    const handler = this.responses.get(fields.Action);
    if (handler) return typeof handler === 'function' ? handler(fields) : handler;
    if (fields.Action === 'PJSIPShowEndpoints' || fields.Action === 'PJSIPShowContacts' || fields.Action === 'CoreShowChannels') {
      return { response: 'Success', events: [], fields: {} };
    }
    return { response: 'Success', message: 'ok', events: [], fields: {} };
  }

  callsFor(action) { return this.calls.filter((c) => c.Action === action); }

  setConnected(connected) {
    this.state = connected ? 'connected' : 'disconnected';
    this.emit(connected ? 'connected' : 'disconnected');
  }

  /** Back to a clean, connected state between tests. */
  reset() {
    this.calls.length = 0;
    this.responses.clear();
    this.state = 'connected';
  }

  /** Make an extension look registered, the same way a real ContactStatus event would. */
  register(endpoint) {
    this.emit('event', { Event: 'ContactStatus', EndpointName: endpoint, ContactStatus: 'Reachable' });
    this.emit('event', { Event: 'DeviceStateChange', Device: `PJSIP/${endpoint}`, State: 'NOT_INUSE' });
  }
}

function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    POSTGRES_HOST: process.env.TEST_PG_HOST || 'localhost',
    POSTGRES_PORT: process.env.TEST_PG_PORT || '5432',
    POSTGRES_DB: 'unused',
    POSTGRES_USER: process.env.TEST_PG_USER || 'postgres',
    POSTGRES_PASSWORD: process.env.TEST_PG_PASSWORD || 'postgres',
    JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    COOKIE_SECURE: 'false',
    ADMIN_PASSWORD: 'Bootstrap-Passw0rd-tests',
    AMI_HOST: 'fake', AMI_USER: 'fake', AMI_PASS: 'fake',
    EXT_1001_PASSWORD: 'ext1001-test-password', EXT_1002_PASSWORD: 'ext1002-test-password',
    EXT_1001_PHONE_PASSWORD: 'phone1001-test-password', EXT_1002_PHONE_PASSWORD: 'phone1002-test-password',
    LOGIN_RATE_LIMIT_MAX: '50',
    ...overrides,
  };
}

function adminPool() {
  return new Pool({
    host: process.env.TEST_PG_HOST || 'localhost',
    port: Number(process.env.TEST_PG_PORT || 5432),
    user: process.env.TEST_PG_USER || 'postgres',
    password: process.env.TEST_PG_PASSWORD || 'postgres',
    database: process.env.TEST_PG_ADMIN_DB || 'postgres',
  });
}

/** Create an isolated database, wire the real services around it, and return a harness. */
async function createHarness({ env = {}, pagingTtl = 20, migrate = true } = {}) {
  const dbName = `test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = adminPool();
  await admin.query(`CREATE DATABASE ${dbName}`);

  const config = loadConfig(testEnv({ POSTGRES_DB: dbName, ...env }));
  const logger = createLogger('silent');
  const db = new Database(config.db, logger);
  if (migrate) await db.migrate(MIGRATIONS);

  const users = new UsersService(db);
  const audit = new AuditService(db, logger);
  const authService = new AuthService({ config, users, audit, logger });
  const ami = new FakeAmi();
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbx-media-'));
  const store = new PbxStore(db, { mediaDir });
  const registry = new PbxRegistry();
  if (migrate) {
    await store.fillMissingSecrets(config.seedSecrets);
    registry.load(await store.snapshot());
  }
  const state = new ExtensionState({ ami, registry, logger });
  const trunkStatus = new TrunkStatus({ ami, registry, logger });
  const generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbx-gen-'));
  const applier = new ConfigApplier({ store, registry, ami, db, logger, dir: generatedDir, debounceMs: 150 });
  const cdr = new CdrService({ db, registry, ami, logger });
  const queueService = new QueueService({ ami, db, logger });
  fs.mkdirSync(path.join(mediaDir, 'voicemail'), { recursive: true });
  fs.mkdirSync(path.join(mediaDir, 'recordings'), { recursive: true });
  const conferenceService = new ConferenceService({ ami, registry, logger });
  const voicemail = new VoicemailService({ db, ami, logger, dir: path.join(mediaDir, 'voicemail') });
  const recordings = new RecordingService({ db, ami, logger, dir: path.join(mediaDir, 'recordings') });
  const paging = new PagingService({ ami, state, registry, audit, logger, authTtlSeconds: pagingTtl });
  const disconnected = [];
  const app = createApp({
    config, logger, db, users, audit, authService, ami, state, paging, registry, store, applier, trunkStatus, cdr, queueService, conferenceService, voicemail, recordings,
    version: 'test', startedAt: Date.now(),
    onUserSecurityChange: (id) => disconnected.push(id),
  });
  // The state tracker is "synced" once AMI has been (fake) connected.
  state.synced = true;
  state.publishAll();

  const agent = () => request(app);

  /** Create a user directly in the database and log in; returns { id, token, headers, ... }. */
  async function login(username, password) {
    const res = await agent().post('/api/auth/login').send({ username, password });
    return res;
  }

  async function makeUser({ username, role, extension = null, password = 'CorrectHorse-Battery-9' }) {
    const user = await users.create({ username, password, role, extension, is_active: true });
    const res = await login(username, password);
    return { ...user, password, token: res.body.token, auth: { Authorization: `Bearer ${res.body.token}` } };
  }

  async function seedAdmin() {
    await users.ensureAdmin(config.adminPassword);
    const res = await login('admin', config.adminPassword);
    const user = (await users.findAuthByUsername('admin'));
    return { id: user.id, username: 'admin', token: res.body.token, auth: { Authorization: `Bearer ${res.body.token}` } };
  }

  async function cleanup() {
    trunkStatus.stop();
    clearTimeout(applier.timer);
    fs.rmSync(generatedDir, { recursive: true, force: true });
    fs.rmSync(mediaDir, { recursive: true, force: true });
    await db.close().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  /** Reset fake AMI + tracker between tests: connected, synced, both extensions registered and idle. */
  function reset() {
    ami.reset();
    state.synced = true;
    ami.register('1001');
    ami.register('1002');
  }

  return { app, agent, reset, config, db, users, audit, authService, ami, state, paging, registry, store, applier, trunkStatus, cdr, queueService, conferenceService, voicemail, recordings, generatedDir, mediaDir, login, makeUser, seedAdmin, cleanup, dbName, disconnected, logger };
}

const auditCount = async (db, where = 'true', params = []) =>
  Number((await db.query(`SELECT count(*) AS n FROM audit_logs WHERE ${where}`, params)).rows[0].n);

module.exports = { createHarness, FakeAmi, MIGRATIONS, auditCount, testEnv, adminPool };
