'use strict';
const { EventEmitter } = require('node:events');

const AVAILABLE_CONTACT = new Set(['Created', 'Updated', 'Reachable', 'NonQualified', 'Avail']);
const UNAVAILABLE_CONTACT = new Set(['Removed', 'Unreachable', 'Unavail', 'Unavailable']);
const IN_USE = new Set(['INUSE', 'BUSY', 'ONHOLD']);
const REGISTERED_DEVICE = new Set(['NOT_INUSE', 'INUSE', 'BUSY', 'RINGING', 'ONHOLD']);

// "Not in use" / "In use" / "Unavailable" (EndpointList) and NOT_INUSE... (DeviceStateChange) -> constant
function normalizeDeviceState(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s,]+/g, '_');
  if (s.includes('UNAVAILABLE')) return 'UNAVAILABLE';
  if (s.includes('NOT_IN_USE') || s.includes('NOT_INUSE')) return 'NOT_INUSE';
  if (s.includes('RINGING')) return 'RINGING';
  if (s.includes('BUSY')) return 'BUSY';
  if (s.includes('HOLD')) return 'ONHOLD';
  if (s.includes('IN_USE') || s.includes('INUSE')) return 'INUSE';
  return 'UNKNOWN';
}

/**
 * Derives extension state (Online / Offline / Ringing / In-Call / Paging) from real
 * Asterisk events. Nothing here is simulated: when AMI is down the state is
 * reported as "Unknown" rather than guessed.
 *
 * Emits: 'change' (public extension object), 'call.started', 'call.ended'.
 */
class ExtensionState extends EventEmitter {
  constructor({ ami, registry, logger }) {
    super();
    this.ami = ami;
    this.registry = registry;
    this.logger = logger;
    this.endpoints = new Map(); // endpoint name -> { contact: bool, device: string }
    this.rebuild();
    this.channels = new Map(); // uniqueid -> channel name
    this.calls = new Map(); // caller uniqueid -> { from, to, startedAt }
    this.paging = null; // { group, caller, targets }
    this.published = new Map(); // ext -> JSON of last emitted state
    this.synced = false;

    registry.on('changed', () => {
      this.rebuild();
      this.publishAll();
    });
    ami.on('event', (evt) => this.onEvent(evt));
    ami.on('connected', () => this.sync());
    ami.on('disconnected', () => {
      this.synced = false;
      this.channels.clear();
      this.calls.clear();
      this.publishAll();
    });
  }

  /** Track exactly the endpoints of the configured extensions; keep what is already known about them. */
  rebuild() {
    const wanted = new Set();
    for (const ext of this.registry.extensionNumbers()) {
      wanted.add(ext);
      wanted.add(`${ext}-phone`);
    }
    for (const name of [...this.endpoints.keys()]) if (!wanted.has(name)) this.endpoints.delete(name);
    for (const name of wanted) if (!this.endpoints.has(name)) this.endpoints.set(name, { contact: false, device: 'UNKNOWN' });
    for (const ext of [...(this.published?.keys() || [])]) {
      if (!this.registry.isExtension(ext)) this.published.delete(ext);
    }
  }

  // ------------------------------------------------------------------ sync
  /** Load current registrations, device states and channels from Asterisk. */
  async sync() {
    try {
      const eps = await this.ami.action({ Action: 'PJSIPShowEndpoints' });
      for (const e of eps.events) {
        if (e.Event !== 'EndpointList') continue;
        const ep = this.endpoints.get(e.ObjectName);
        if (ep) ep.device = normalizeDeviceState(e.DeviceState);
      }
      const contacts = await this.ami.action({ Action: 'PJSIPShowContacts' });
      for (const ep of this.endpoints.values()) ep.contact = false;
      for (const c of contacts.events) {
        if (c.Event !== 'ContactList') continue;
        const ep = this.endpoints.get(c.EndpointName);
        if (ep && AVAILABLE_CONTACT.has(c.Status)) ep.contact = true;
      }
      this.channels.clear();
      try {
        const chans = await this.ami.action({ Action: 'CoreShowChannels' });
        for (const c of chans.events) {
          if (c.Event === 'CoreShowChannel' && c.Channel?.startsWith('PJSIP/')) this.channels.set(c.Uniqueid, c.Channel);
        }
      } catch (err) {
        this.logger.warn({ err: err.message }, 'could not list channels during sync');
      }
      this.synced = true;
      this.logger.info('extension state synchronised from Asterisk');
    } catch (err) {
      this.logger.error({ err: err.message }, 'extension state sync failed');
    }
    this.publishAll();
  }

  // ---------------------------------------------------------------- events
  onEvent(evt) {
    switch (evt.Event) {
      case 'ContactStatus': {
        const ep = this.endpoints.get(evt.EndpointName);
        if (!ep) return;
        if (AVAILABLE_CONTACT.has(evt.ContactStatus)) ep.contact = true;
        else if (UNAVAILABLE_CONTACT.has(evt.ContactStatus)) ep.contact = false;
        this.publish(this.registry.extensionFromEndpoint(evt.EndpointName));
        return;
      }
      case 'DeviceStateChange': {
        const device = String(evt.Device || '');
        if (!device.startsWith('PJSIP/')) return;
        const ep = this.endpoints.get(device.slice(6));
        if (!ep) return;
        ep.device = normalizeDeviceState(evt.State);
        this.publish(this.registry.extensionFromEndpoint(device.slice(6)));
        return;
      }
      case 'Newchannel':
        if (String(evt.Channel).startsWith('PJSIP/')) this.channels.set(evt.Uniqueid, evt.Channel);
        return;
      case 'DialEnd':
        this.onDialEnd(evt);
        return;
      case 'Hangup': {
        const channel = this.channels.get(evt.Uniqueid) || evt.Channel;
        this.channels.delete(evt.Uniqueid);
        const call = this.calls.get(evt.Uniqueid);
        if (call) {
          this.calls.delete(evt.Uniqueid);
          this.emit('call.ended', { from: call.from, to: call.to, durationSeconds: Math.round((Date.now() - call.startedAt) / 1000) });
        }
        const ext = this.registry.extensionFromChannel(channel);
        if (ext) this.publish(ext);
        return;
      }
      default:
    }
  }

  onDialEnd(evt) {
    if (evt.DialStatus !== 'ANSWER' || this.paging) return;
    const from = this.registry.extensionFromChannel(evt.Channel) || (this.registry.isExtension(evt.CallerIDNum) ? evt.CallerIDNum : null);
    const to = this.registry.extensionFromChannel(evt.DestChannel) || (this.registry.isExtension(evt.DestCallerIDNum) ? evt.DestCallerIDNum : null);
    if (!from || !to || from === to) return;
    this.calls.set(evt.UniqueID || evt.Uniqueid, { from, to, startedAt: Date.now() });
    this.emit('call.started', { from, to });
  }

  // ---------------------------------------------------------------- paging
  setPaging(info) {
    const before = this.paging;
    this.paging = info;
    const touched = new Set([...(before ? [before.caller, ...before.targets] : []), ...(info ? [info.caller, ...info.targets] : [])]);
    for (const ext of touched) this.publish(ext);
  }

  // ------------------------------------------------------------ derivation
  compute(ext) {
    const eps = [this.endpoints.get(ext), this.endpoints.get(`${ext}-phone`)];
    const registered = eps.some((e) => e.contact || REGISTERED_DEVICE.has(e.device));
    const inCall = eps.some((e) => IN_USE.has(e.device));
    const ringing = eps.some((e) => e.device === 'RINGING');
    const paging = !!this.paging && (this.paging.caller === ext || this.paging.targets.includes(ext));
    let state;
    if (!this.ami.isConnected() || !this.synced) state = 'Unknown';
    else if (paging) state = 'Paging';
    else if (inCall) state = 'In-Call';
    else if (ringing) state = 'Ringing';
    else if (registered) state = 'Online';
    else state = 'Offline';
    return {
      extension: ext,
      name: this.registry.extension(ext).name,
      state,
      registered: state === 'Unknown' ? null : registered,
      clients: {
        browser: this.endpoints.get(ext).contact || REGISTERED_DEVICE.has(this.endpoints.get(ext).device),
        phone: this.endpoints.get(`${ext}-phone`).contact || REGISTERED_DEVICE.has(this.endpoints.get(`${ext}-phone`).device),
      },
    };
  }

  snapshot() {
    return this.registry.extensionNumbers().map((ext) => this.compute(ext));
  }

  get(ext) {
    return this.registry.isExtension(ext) ? this.compute(ext) : null;
  }

  /** Live PJSIP channels belonging to an extension (browser or phone). */
  channelsFor(ext) {
    return [...this.channels.values()].filter((c) => this.registry.extensionFromChannel(c) === ext);
  }

  publish(ext) {
    if (!ext || !this.registry.isExtension(ext)) return;
    const current = this.compute(ext);
    const json = JSON.stringify(current);
    if (this.published.get(ext) === json) return;
    this.published.set(ext, json);
    this.emit('change', current);
  }

  publishAll() {
    for (const ext of this.registry.extensionNumbers()) this.publish(ext);
  }
}

module.exports = { ExtensionState, normalizeDeviceState };
