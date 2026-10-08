'use strict';
const { conflict, badRequest } = require('../errors');

const ROOM_EVENTS = new Set(['ConfbridgeJoin', 'ConfbridgeLeave', 'ConfbridgeMute', 'ConfbridgeUnmute', 'ConfbridgeLock', 'ConfbridgeUnlock', 'ConfbridgeEnd']);
const yes = (v) => String(v).toLowerCase() === 'yes' || v === true;
const ACTIONS = {
  kick: 'ConfbridgeKick', mute: 'ConfbridgeMute', unmute: 'ConfbridgeUnmute', lock: 'ConfbridgeLock', unlock: 'ConfbridgeUnlock',
};

/**
 * Live state of conference rooms, and the controls (kick, mute, lock). Everything comes from Asterisk (ConfbridgeListRooms /
 * ConfbridgeList); rooms that nobody is in do not exist there. A control can only be applied to someone who is in the room
 * right now, so a stale or made-up channel name is refused instead of being passed to Asterisk.
 */
class ConferenceService {
  constructor({ ami, registry, logger }) {
    this.ami = ami;
    this.registry = registry;
    this.logger = logger;
    this.onChange = null;
    ami.on('event', (evt) => {
      if (ROOM_EVENTS.has(evt.Event) && /^\d{3,6}$/.test(evt.Conference || '')) this.onChange?.({ room: evt.Conference });
    });
  }

  async participants(room) {
    let res;
    try {
      res = await this.ami.action({ Action: 'ConfbridgeList', Conference: room });
    } catch (err) {
      if (/no conference|not found/i.test(err.message)) return [];
      throw err;
    }
    if (res.response === 'Error') return [];
    return (res.events || []).filter((e) => e.Event === 'ConfbridgeList').map((e) => ({
      channel: e.Channel,
      caller: e.CallerIDNum && e.CallerIDNum !== '<unknown>' ? e.CallerIDNum : '',
      name: e.CallerIDName && e.CallerIDName !== '<unknown>' ? e.CallerIDName : '',
      extension: this.registry.extensionFromChannel(e.Channel),
      admin: yes(e.Admin),
      muted: yes(e.Muted),
      talking: String(e.Talking || '').toLowerCase() === 'yes',
    }));
  }

  /** Rooms with people in them, from Asterisk. */
  async status() {
    if (!this.ami.isConnected()) return { available: false, rooms: [] };
    const res = await this.ami.action({ Action: 'ConfbridgeListRooms' });
    const rooms = [];
    for (const e of (res.events || []).filter((x) => x.Event === 'ConfbridgeListRooms')) {
      if (!/^\d{3,6}$/.test(e.Conference || '')) continue;
      rooms.push({
        number: e.Conference, parties: Number(e.Parties) || 0, locked: yes(e.Locked), marked: Number(e.Marked) || 0,
        participants: await this.participants(e.Conference),
      });
    }
    return { available: true, rooms };
  }

  async control(room, action, channel = null) {
    const command = ACTIONS[action];
    if (!command) throw badRequest('Unknown conference action', 'bad_action');
    if (!this.ami.isConnected()) throw conflict('The telephony system is not connected', 'ami_down');
    const fields = { Action: command, Conference: room };
    if (channel) {
      const here = (await this.participants(room)).some((p) => p.channel === channel);
      if (!here) throw conflict('That person is no longer in the room', 'not_in_room');
      fields.Channel = channel;
    }
    const res = await this.ami.action(fields);
    if (res.response !== 'Success') throw conflict(res.message || 'Asterisk refused the request', 'refused');
  }
}

module.exports = { ConferenceService };
