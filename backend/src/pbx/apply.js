'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { renderAll, renderQueues, queueOrders } = require('./render');

const FILES = { pjsip: 'pjsip_generated.conf', dialplan: 'extensions_generated.conf', queues: 'queues_generated.conf' };

/**
 * Turns the database into live Asterisk configuration:
 *   database -> registry (in-memory plan) -> rendered files in a volume shared with Asterisk
 *            -> AMI "module reload" + "dialplan reload" -> verification -> apply log.
 *
 * Applies are serialised and debounced, so a burst of edits causes one reload. If Asterisk (AMI) is not
 * reachable the files are still written and a reload happens as soon as AMI connects.
 *
 * Emits: 'applied' (result), 'failed' (result).
 */
class ConfigApplier extends EventEmitter {
  constructor({ store, registry, ami, db, logger, dir, onReloaded, debounceMs = 400 }) {
    super();
    this.store = store;
    this.registry = registry;
    this.ami = ami;
    this.db = db;
    this.logger = logger;
    this.dir = dir;
    this.onReloaded = onReloaded;
    this.debounceMs = debounceMs;
    this.chain = Promise.resolve();
    this.timer = null;
    this.pendingReasons = new Set();
    this.last = null; // last result
    this.checksum = null; // checksum of the files currently on disk
    this.reloadedChecksum = null; // checksum Asterisk last confirmed loading
    this.sums = { pjsip: null, dialplan: null, queues: null }; // per-file checksums on disk
    this.loaded = { pjsip: null, dialplan: null, queues: null }; // per-file checksums Asterisk last confirmed loading
    this.queueOrder = new Map(); // in-order queues -> agent order Asterisk currently holds

    ami.on('connected', () => {
      if (this.checksum && this.reloadedChecksum !== this.checksum) this.schedule('ami-connected');
    });
  }

  status() {
    return {
      checksum: this.checksum,
      reloadedChecksum: this.reloadedChecksum,
      inSync: !!this.checksum && this.checksum === this.reloadedChecksum,
      pending: this.pendingReasons.size > 0,
      last: this.last,
    };
  }

  /** Coalesce changes made within debounceMs into a single apply. */
  schedule(reason) {
    this.pendingReasons.add(reason);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const reasons = [...this.pendingReasons].join(',');
      this.pendingReasons.clear();
      this.apply(reasons).catch(() => {});
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Apply now (serialised). Resolves with the result; rejects only for programming errors. */
  apply(reason, { force = false } = {}) {
    const run = this.chain.then(() => this.run(reason, force));
    this.chain = run.catch(() => {});
    return run;
  }

  async run(reason, force) {
    const startedAt = new Date();
    let result;
    try {
      const snapshot = await this.store.snapshot();
      this.registry.load(snapshot);
      const rendered = renderAll(snapshot);
      const changed = rendered.checksum !== this.checksum;
      if (changed) {
        await this.writeFiles(rendered, {
          pjsip: rendered.pjsipChecksum !== this.sums.pjsip,
          dialplan: rendered.dialplanChecksum !== this.sums.dialplan,
          queues: rendered.queuesChecksum !== this.sums.queues,
        });
      }
      this.checksum = rendered.checksum;
      this.sums = { pjsip: rendered.pjsipChecksum, dialplan: rendered.dialplanChecksum, queues: rendered.queuesChecksum };

      // Only what changed is reloaded: a dialplan-only edit (do not disturb, a route ...) never touches SIP
      // registrations or trunk state.
      const needPjsip = force || this.loaded.pjsip !== rendered.pjsipChecksum;
      const needDialplan = force || this.loaded.dialplan !== rendered.dialplanChecksum;
      const needQueues = force || this.loaded.queues !== rendered.queuesChecksum;
      let reloaded = false;
      if (this.ami.isConnected() && (needPjsip || needDialplan || needQueues)) {
        if (needPjsip) {
          await this.reloadPjsip();
          this.loaded.pjsip = rendered.pjsipChecksum;
        }
        if (needQueues) {
          // Asterisk keeps the member order it first loaded and a reload does not reorder it. For an in-order queue whose
          // agent order changed, reload once without the queue (Asterisk forgets it) and again with it.
          const order = queueOrders(snapshot);
          const linear = new Set(snapshot.queues.filter((q) => q.strategy === 'linear').map((q) => q.number));
          const reordered = [...order].filter(([n, o]) => linear.has(n) && this.queueOrder.has(n) && this.queueOrder.get(n) !== o).map(([n]) => n);
          if (reordered.length) {
            await this.writeFiles({ queues: renderQueues({ ...snapshot, queues: snapshot.queues.filter((q) => !reordered.includes(q.number)) }) }, { queues: true });
            await this.reloadQueues();
            await new Promise((r) => setTimeout(r, 300));
            await this.writeFiles(rendered, { queues: true });
          }
          // Before the dialplan: a dialplan that sends calls to a queue must find the queue already defined.
          await this.reloadQueues();
          this.loaded.queues = rendered.queuesChecksum;
          this.queueOrder = order;
        }
        if (needDialplan) {
          await this.reloadDialplan();
          this.loaded.dialplan = rendered.dialplanChecksum;
        }
        this.reloadedChecksum = rendered.checksum;
        reloaded = true;
        if (needPjsip) {
          await this.qualifyTrunks(snapshot.trunks);
          try {
            await this.onReloaded?.();
          } catch (err) {
            this.logger.warn({ err: err.message }, 'post-reload refresh failed');
          }
        }
      }
      result = { ok: true, reason, checksum: rendered.checksum, changed, reloaded, at: startedAt, error: null };
      this.logger.info({ reason, changed, reloaded, checksum: rendered.checksum.slice(0, 12) }, 'PBX configuration applied');
    } catch (err) {
      result = { ok: false, reason, checksum: this.checksum, changed: false, reloaded: false, at: startedAt, error: err.message };
      this.logger.error({ reason, err: err.message }, 'PBX configuration apply failed');
    }
    this.last = result;
    await this.db
      .query('INSERT INTO pbx_apply_log (ok, checksum, reason, error) VALUES ($1,$2,$3,$4)', [result.ok, result.checksum, String(reason).slice(0, 200), result.error])
      .catch((err) => this.logger.warn({ err: err.message }, 'could not record apply result'));
    this.emit(result.ok ? 'applied' : 'failed', result);
    return result;
  }

  async writeFiles({ pjsip, dialplan, queues }, which = { pjsip: true, dialplan: true, queues: true }) {
    await fs.mkdir(this.dir, { recursive: true });
    const write = async (name, content) => {
      const target = path.join(this.dir, name);
      const tmp = `${target}.tmp-${process.pid}`;
      await fs.writeFile(tmp, content, { mode: 0o644 });
      await fs.rename(tmp, target);
    };
    // Dialplan first: a new PJSIP object is only reachable through the dialplan that references it.
    if (which.queues) await write(FILES.queues, queues);
    if (which.dialplan) await write(FILES.dialplan, dialplan);
    if (which.pjsip) await write(FILES.pjsip, pjsip);
  }

  async command(cmd) {
    const res = await this.ami.action({ Action: 'Command', Command: cmd }, { timeoutMs: 20000 });
    if (res.response === 'Error') throw new Error(res.message || `AMI refused "${cmd}"`);
    return String(res.fields?.Output || res.message || '');
  }

  /** Check reachability of new/changed trunks now instead of waiting for Asterisk's next OPTIONS cycle. Best effort. */
  async qualifyTrunks(trunks) {
    for (const t of trunks) {
      if (!t.enabled || !t.qualify) continue;
      try {
        await this.command(`pjsip qualify trk-${t.name}`);
      } catch (err) {
        this.logger.debug({ err: err.message, trunk: t.name }, 'trunk qualify failed');
      }
    }
  }

  async reloadPjsip() {
    const pj = await this.command('module reload res_pjsip.so');
    if (/failed|error|not found|unable/i.test(pj) && !/reloaded successfully/i.test(pj)) throw new Error(`PJSIP reload failed: ${pj.trim().slice(0, 300)}`);
  }

  async reloadQueues() {
    const out = await this.command('queue reload all');
    if (/unable|error|failed/i.test(out)) throw new Error(`Queue reload failed: ${out.trim().slice(0, 300)}`);
  }

  async reloadDialplan() {
    const dp = await this.command('dialplan reload');
    if (/failed|error|unable/i.test(dp)) throw new Error(`Dialplan reload failed: ${dp.trim().slice(0, 300)}`);
  }
}

module.exports = { ConfigApplier, FILES };
