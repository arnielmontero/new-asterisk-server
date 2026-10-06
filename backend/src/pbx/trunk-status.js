'use strict';
const { EventEmitter } = require('node:events');

const REACHABLE = new Set(['Reachable', 'Avail', 'Created', 'Updated']);
const UNREACHABLE = new Set(['Unreachable', 'Unavail', 'Unavailable', 'Removed']);

/**
 * Live trunk health from real Asterisk data: outbound registration status (register trunks), OPTIONS
 * reachability (qualify) and the number of active channels. Nothing is guessed: with AMI down every
 * trunk is reported as "unknown".
 *
 * Emits 'change' with the full snapshot whenever anything differs from the last one emitted.
 */
class TrunkStatus extends EventEmitter {
  constructor({ ami, registry, logger, pollMs = 15000 }) {
    super();
    this.ami = ami;
    this.registry = registry;
    this.logger = logger;
    this.pollMs = pollMs;
    this.registration = new Map(); // trunk name -> 'Registered' | 'Rejected' | 'Unregistered' | ...
    this.contact = new Map(); // trunk name -> 'Reachable' | 'Unreachable' | 'NonQualified'
    this.channels = new Map(); // trunk name -> count
    this.timer = null;
    this.refreshTimer = null;
    this.lastJson = '';

    ami.on('connected', () => this.refresh());
    ami.on('disconnected', () => this.publish());
    registry.on('changed', () => this.publish());
    ami.on('event', (evt) => this.onEvent(evt));
  }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.refreshTimer);
  }

  onEvent(evt) {
    if (evt.Event === 'ContactStatus') {
      const name = this.registry.trunkFromEndpoint(evt.EndpointName);
      if (!name) return;
      this.contact.set(name, REACHABLE.has(evt.ContactStatus) ? 'Reachable' : UNREACHABLE.has(evt.ContactStatus) ? 'Unreachable' : 'NonQualified');
      this.publish();
    } else if (evt.Event === 'Registry' || evt.Event === 'Newchannel' || evt.Event === 'Hangup') {
      // Cheap and always correct: re-read the real state shortly after anything that could change it.
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh().catch(() => {}), 500);
      this.refreshTimer.unref?.();
    }
  }

  async refresh() {
    if (!this.ami.isConnected()) {
      this.publish();
      return;
    }
    try {
      const regs = await this.ami.action({ Action: 'PJSIPShowRegistrationsOutbound' });
      this.registration.clear();
      for (const e of regs.events) {
        if (e.Event !== 'OutboundRegistrationDetail') continue;
        const name = this.registry.trunkFromEndpoint(e.ObjectName);
        if (name) this.registration.set(name, e.Status);
      }
      // Reachability comes from the endpoint list, not the contact list: PJSIPShowContacts only lists registered
      // contacts, so a trunk with a static contact would never appear there. An endpoint whose device state is
      // "Unavailable" has no reachable contact (its OPTIONS qualify failed).
      const endpoints = await this.ami.action({ Action: 'PJSIPShowEndpoints' });
      this.contact.clear();
      for (const e of endpoints.events) {
        if (e.Event !== 'EndpointList') continue;
        const name = this.registry.trunkFromEndpoint(e.ObjectName);
        if (name) this.contact.set(name, /unavailable/i.test(e.DeviceState || '') ? 'Unreachable' : 'Reachable');
      }
      const chans = await this.ami.action({ Action: 'CoreShowChannels' });
      this.channels.clear();
      for (const e of chans.events) {
        if (e.Event !== 'CoreShowChannel') continue;
        const name = this.registry.trunkFromChannel(e.Channel);
        if (name) this.channels.set(name, (this.channels.get(name) || 0) + 1);
      }
    } catch (err) {
      this.logger.warn({ err: err.message }, 'trunk status refresh failed');
    }
    this.publish();
  }

  compute(trunk) {
    const base = { name: trunk.name, displayName: trunk.displayName, authMode: trunk.authMode, activeChannels: this.channels.get(trunk.name) || 0 };
    if (!trunk.enabled) return { ...base, state: 'disabled', detail: 'Disabled' };
    if (!this.ami.isConnected()) return { ...base, state: 'unknown', detail: 'Telephony system not connected' };
    const reg = this.registration.get(trunk.name);
    const contact = this.contact.get(trunk.name);
    if (trunk.authMode === 'register') {
      if (reg === 'Registered') return { ...base, state: 'online', detail: 'Registered' };
      if (reg === 'Rejected') return { ...base, state: 'offline', detail: 'Registration rejected by the provider (check username/password)' };
      if (reg === 'Unregistered') return { ...base, state: 'offline', detail: 'Not registered' };
      if (reg) return { ...base, state: 'unknown', detail: reg };
      return { ...base, state: 'unknown', detail: 'Waiting for the first registration attempt' };
    }
    if (!trunk.qualify) return { ...base, state: 'unknown', detail: 'Reachability checking is switched off for this trunk' };
    if (contact === 'Reachable') return { ...base, state: 'online', detail: 'Reachable' };
    if (contact === 'Unreachable') return { ...base, state: 'offline', detail: 'Not answering SIP OPTIONS' };
    return { ...base, state: 'unknown', detail: 'Reachability checking is off or has not run yet' };
  }

  snapshot() {
    return [...this.registry.trunks.values()].map((t) => this.compute(t));
  }

  publish() {
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.emit('change', snap);
  }
}

module.exports = { TrunkStatus };
