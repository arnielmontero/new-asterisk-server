'use strict';
const { EventEmitter } = require('node:events');

const ECHO_EXTENSION = '600';

/**
 * In-memory view of the PBX plan (extensions, paging groups, trunks), loaded from the database.
 * The database is the source of truth; this exists so the hot paths (AMI events, paging, socket
 * snapshots) never have to query it. `load()` is called at start and after every configuration change.
 *
 * Emits 'changed' after every load.
 */
class PbxRegistry extends EventEmitter {
  constructor() {
    super();
    this.extensions = new Map(); // number -> { number, name, webrtc, phone }
    this.groups = new Map(); // number -> { number, name, members: [] }
    this.trunks = new Map(); // name -> { id, name, displayName, authMode, host, enabled }
  }

  load({ extensions = [], groups = [], trunks = [] }) {
    this.extensions = new Map(
      extensions
        .filter((e) => e.enabled)
        .map((e) => [e.number, { number: e.number, name: e.display_name, webrtc: !!e.webrtc_enabled, phone: !!e.phone_enabled }]),
    );
    this.groups = new Map(
      groups
        .filter((g) => g.enabled)
        .map((g) => [g.number, { number: g.number, name: g.name, members: g.members.filter((m) => this.extensions.has(m)) }]),
    );
    this.trunks = new Map(
      trunks.map((t) => [t.name, { id: Number(t.id), name: t.name, displayName: t.display_name, authMode: t.auth_mode, host: t.host, enabled: t.enabled }]),
    );
    this.emit('changed');
  }

  get echoExtension() { return ECHO_EXTENSION; }

  extensionNumbers() { return [...this.extensions.keys()]; }

  isExtension(n) { return this.extensions.has(String(n)); }

  isPagingGroup(n) { return this.groups.has(String(n)); }

  extension(n) { return this.extensions.get(String(n)) || null; }

  group(n) { return this.groups.get(String(n)) || null; }

  pagingGroups() { return [...this.groups.values()]; }

  /** Members of a paging group, excluding the caller (an extension never pages itself). */
  pagingTargets(group, callerExtension) {
    return (this.groups.get(String(group))?.members || []).filter((m) => m !== callerExtension);
  }

  // Endpoint names: "1001" (browser), "1001-phone" (physical phone) or "trk-<name>" (trunk).
  extensionFromEndpoint(endpoint) {
    const m = /^(\d{3,6})(?:-phone)?$/.exec(String(endpoint || ''));
    return m && this.isExtension(m[1]) ? m[1] : null;
  }

  // Channel names: "PJSIP/1001-0000002a", "PJSIP/1001-phone-0000002a", "PJSIP/trk-acme-0000002a".
  extensionFromChannel(channel) {
    const m = /^PJSIP\/(\d{3,6})(?:-phone)?-[0-9a-f]{8}$/.exec(String(channel || ''));
    return m && this.isExtension(m[1]) ? m[1] : null;
  }

  trunkFromChannel(channel) {
    const m = /^PJSIP\/trk-([a-z][a-z0-9_-]*)-[0-9a-f]{8}$/.exec(String(channel || ''));
    return m ? m[1] : null;
  }

  trunkFromEndpoint(endpoint) {
    const m = /^trk-([a-z][a-z0-9_-]*)$/.exec(String(endpoint || ''));
    return m && this.trunks.has(m[1]) ? m[1] : null;
  }
}

module.exports = { PbxRegistry, ECHO_EXTENSION };
