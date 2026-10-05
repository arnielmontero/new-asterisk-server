'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const CRLF = '\r\n';
const FRAME_END = '\r\n\r\n';

/**
 * Minimal Asterisk Manager Interface client.
 *
 * - connects and authenticates, then emits `event` for every AMI event
 * - correlates actions to responses by ActionID (incl. multi-event lists)
 * - detects dead links with periodic Ping and reconnects with exponential backoff
 * - never throws out of the event loop: failures surface as state changes
 *
 * Events: 'connected', 'disconnected', 'event' (parsed object), 'state' (string).
 */
class AmiClient extends EventEmitter {
  constructor({
    host,
    port,
    username,
    secret,
    logger,
    connectTimeoutMs = 5000,
    actionTimeoutMs = 8000,
    pingIntervalMs = 10000,
    pingTimeoutMs = 5000,
    backoff = { initialMs: 500, maxMs: 5000, factor: 2 },
  }) {
    super();
    this.opts = { host, port, username, secret, connectTimeoutMs, actionTimeoutMs, pingIntervalMs, pingTimeoutMs, backoff };
    this.logger = logger;
    this.state = 'disconnected'; // disconnected | connecting | connected
    this.socket = null;
    this.buffer = '';
    this.pending = new Map(); // ActionID -> { resolve, reject, timer, events, isList }
    this.attempt = 0;
    this.stopping = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastError = null;
    this.asteriskBanner = null;
  }

  // ------------------------------------------------------------- lifecycle
  start() {
    this.stopping = false;
    this.connect();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.socket && this.state === 'connected') {
      try {
        await this.action({ Action: 'Logoff' }, { timeoutMs: 1000 });
      } catch {
        /* closing anyway */
      }
    }
    this.socket?.destroy();
    this.setState('disconnected');
  }

  isConnected() {
    return this.state === 'connected';
  }

  status() {
    return {
      state: this.state,
      host: this.opts.host,
      port: this.opts.port,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      reconnectAttempt: this.attempt,
      banner: this.asteriskBanner,
    };
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  // ------------------------------------------------------------ connection
  connect() {
    if (this.stopping) return;
    this.setState('connecting');
    this.buffer = '';
    this.asteriskBanner = null;
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setTimeout(this.opts.connectTimeoutMs);

    socket.on('connect', () => socket.setTimeout(0));
    socket.on('timeout', () => {
      this.lastError = 'connect timeout';
      socket.destroy();
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => {
      this.lastError = err.code || err.message;
    });
    socket.on('close', () => {
      // Ignore a late close from a socket we have already replaced.
      if (this.socket === socket) this.handleClosed();
    });

    // Login is sent when the banner arrives (see onData).
    this.loginHandler = async () => {
      try {
        const res = await this.action(
          { Action: 'Login', Username: this.opts.username, Secret: this.opts.secret },
          { timeoutMs: this.opts.connectTimeoutMs, allowWhileConnecting: true },
        );
        if (res.response !== 'Success') throw new Error(res.message || 'authentication failed');
        this.attempt = 0;
        this.lastConnectedAt = new Date();
        this.lastError = null;
        this.setState('connected');
        this.startPing();
        this.logger.info({ host: this.opts.host, port: this.opts.port, banner: this.asteriskBanner }, 'AMI connected');
        this.emit('connected');
      } catch (err) {
        this.lastError = err.message;
        this.logger.warn({ err: err.message }, 'AMI login failed');
        socket.destroy(); // the close handler schedules the reconnect
      }
    };
  }

  handleClosed() {
    clearInterval(this.pingTimer);
    const wasConnected = this.state === 'connected';
    this.socket = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('AMI connection closed'));
      this.pending.delete(id);
    }
    this.lastDisconnectedAt = new Date();
    this.setState('disconnected');
    if (wasConnected) {
      this.logger.warn({ lastError: this.lastError }, 'AMI disconnected');
      this.emit('disconnected');
    }
    if (!this.stopping) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const { initialMs, maxMs, factor } = this.opts.backoff;
    const delay = Math.min(maxMs, initialMs * factor ** this.attempt);
    this.attempt += 1;
    this.logger.info({ delayMs: delay, attempt: this.attempt }, 'AMI reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(async () => {
      try {
        await this.action({ Action: 'Ping' }, { timeoutMs: this.opts.pingTimeoutMs });
      } catch (err) {
        this.logger.warn({ err: err.message }, 'AMI ping failed; dropping connection');
        this.lastError = 'ping timeout';
        this.socket?.destroy();
      }
    }, this.opts.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  // --------------------------------------------------------------- parsing
  onData(chunk) {
    this.buffer += chunk;
    if (this.asteriskBanner === null) {
      const idx = this.buffer.indexOf(CRLF);
      if (idx === -1) return;
      this.asteriskBanner = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + CRLF.length);
      if (!/^Asterisk Call Manager/i.test(this.asteriskBanner)) {
        this.lastError = 'unexpected banner';
        this.socket?.destroy();
        return;
      }
      this.loginHandler?.();
    }
    let end;
    while ((end = this.buffer.indexOf(FRAME_END)) !== -1) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + FRAME_END.length);
      if (frame.trim()) this.onMessage(parseFrame(frame));
    }
  }

  onMessage(msg) {
    const id = msg.ActionID;
    const p = id ? this.pending.get(id) : null;

    if (msg.Response !== undefined) {
      if (!p) return;
      const listStart = String(msg.EventList || '').toLowerCase() === 'start';
      if (listStart) {
        p.isList = true;
        p.head = msg;
        return; // resolved on the matching *Complete event
      }
      this.finish(id, { response: msg.Response, message: msg.Message, fields: msg, events: p.events });
      return;
    }

    if (msg.Event !== undefined) {
      if (p?.isList) {
        if (String(msg.EventList || '').toLowerCase() === 'complete') {
          this.finish(id, { response: p.head?.Response || 'Success', message: p.head?.Message, fields: p.head, events: p.events });
        } else {
          p.events.push(msg);
        }
        return;
      }
      this.emit('event', msg);
    }
  }

  finish(id, result) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ ...result, response: String(result.response), });
  }

  // --------------------------------------------------------------- actions
  /**
   * Send an AMI action. Resolves with { response, message, fields, events }.
   * `response` is "Success" | "Error" | "Follows"...; callers decide what is an error.
   */
  action(fields, { timeoutMs = this.opts.actionTimeoutMs, allowWhileConnecting = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || (!allowWhileConnecting && this.state !== 'connected')) {
        reject(new Error('AMI is not connected'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`AMI action ${fields.Action} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, events: [], isList: false });
      const lines = [`ActionID: ${id}`];
      for (const [k, v] of Object.entries(fields)) {
        if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('Invalid characters in AMI field'));
          return;
        }
        lines.push(`${k}: ${v}`);
      }
      this.socket.write(lines.join(CRLF) + FRAME_END);
    });
  }
}

function parseFrame(frame) {
  const msg = {};
  for (const line of frame.split(CRLF)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).replace(/^ /, '');
    if (key === 'Output') {
      msg.Output = msg.Output === undefined ? value : `${msg.Output}\n${value}`;
    } else {
      msg[key] = value;
    }
  }
  return msg;
}

module.exports = { AmiClient, parseFrame };
