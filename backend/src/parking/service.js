'use strict';
const { EventEmitter } = require('node:events');

const SLOT_RE = /^75[1-9]$/;
const text = (v) => (v && v !== '<unknown>' ? String(v) : '');

/**
 * Parked calls, from Asterisk's own events: ParkedCall adds one, UnParkedCall / ParkedCallTimeOut / ParkedCallGiveUp remove
 * it. After a reconnect the list is rebuilt with the ParkedCalls action, so the dashboard never shows a call that is gone.
 *
 * Emits: 'change' (list).
 */
class ParkingService extends EventEmitter {
  constructor({ ami, registry, logger }) {
    super();
    this.ami = ami;
    this.registry = registry;
    this.logger = logger;
    this.slots = new Map(); // slot -> { slot, uniqueId, caller, name, parkedBy, parkedAt, expiresAt }
    ami.on('event', (evt) => this.onEvent(evt));
    ami.on('connected', () => this.sync().catch((err) => logger.warn({ err: err.message }, 'parked call sync failed')));
    ami.on('disconnected', () => { if (this.slots.size) { this.slots.clear(); this.emit('change', this.list()); } });
  }

  list() {
    return [...this.slots.values()].sort((a, b) => a.slot.localeCompare(b.slot)).map((p) => ({
      slot: p.slot, caller: p.caller, name: p.name, parkedBy: p.parkedBy, parkedAt: p.parkedAt, secondsLeft: Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)),
    }));
  }

  add(evt) {
    const slot = String(evt.ParkingSpace || '');
    if (!SLOT_RE.test(slot)) return;
    const timeout = Number.parseInt(evt.ParkingTimeout, 10);
    const duration = Number.parseInt(evt.ParkingDuration, 10) || 0;
    // ParkerDialString is "PJSIP/1002": the extension that parked the call.
    const parker = /^PJSIP\/(\d{3,6})(?:-phone)?$/.exec(String(evt.ParkerDialString || ''));
    this.slots.set(slot, {
      slot,
      uniqueId: evt.ParkeeUniqueid || '',
      caller: text(evt.ParkeeCallerIDNum),
      name: text(evt.ParkeeCallerIDName),
      parkedBy: parker && this.registry.isExtension(parker[1]) ? parker[1] : null,
      parkedAt: new Date(Date.now() - duration * 1000).toISOString(),
      expiresAt: Date.now() + (Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 0),
    });
  }

  onEvent(evt) {
    switch (evt.Event) {
      case 'ParkedCall':
        // Also the answer to the ParkedCalls action during a sync (those events carry no EventList marker we need here).
        this.add(evt);
        this.emit('change', this.list());
        return;
      case 'UnParkedCall':
      case 'ParkedCallTimeOut':
      case 'ParkedCallGiveUp': {
        let changed = false;
        for (const [slot, p] of this.slots) {
          if ((evt.ParkeeUniqueid && p.uniqueId === evt.ParkeeUniqueid) || (!evt.ParkeeUniqueid && evt.ParkingSpace === slot)) { this.slots.delete(slot); changed = true; }
        }
        if (changed) this.emit('change', this.list());
        return;
      }
      default:
    }
  }

  /** Replace the list with what Asterisk reports now. */
  async sync() {
    const res = await this.ami.action({ Action: 'ParkedCalls' });
    if (res.response === 'Error') return;
    this.slots.clear();
    for (const e of res.events || []) if (e.Event === 'ParkedCall') this.add(e);
    this.emit('change', this.list());
  }
}

module.exports = { ParkingService };
