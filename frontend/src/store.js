// Minimal observable application state shared by the views.
const listeners = new Set();

export const store = {
  state: {
    user: null, // { id, username, role, extension }
    extensions: [], // [{ extension, name, state, registered, clients }]
    pagingGroups: [], // [{ number, name, members }]
    echoExtension: '600',
    page: null, // current page { group, name, status, ... } or null
    ami: null, // admins only: { state, ... }
    trunks: [], // admins only: live trunk status [{ name, state, detail, activeChannels }]
    pbx: null, // admins only: configuration apply status { inSync, pending, last }
    cdrTick: 0, // bumped whenever a call record is stored; views refresh on change
    conferenceTick: 0, // bumped whenever someone joins, leaves or is muted in a conference room
    voicemailTick: 0, // bumped whenever a voicemail message arrives, is heard or deleted
    socketConnected: false,
    backendOk: true,
    sip: { state: 'idle', reason: '' }, // idle | registering | registered | failed | disabled
    call: null, // { direction, peer, state, paging, muted }
    incoming: null, // { from } ringing, awaiting answer/reject
    audioReady: false,
    audioBlocked: false,
    toasts: [],
  },
  set(patch) {
    Object.assign(this.state, patch);
    for (const fn of listeners) fn(this.state);
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  toast(message, kind = 'error') {
    const id = Math.random().toString(36).slice(2);
    this.set({ toasts: [...this.state.toasts, { id, message, kind }] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), kind === 'error' ? 9000 : 4000);
  },
};

export const canUseSoftphone = (user) => !!user && ['admin', 'operator'].includes(user.role) && !!user.extension;
export const canControlCalls = (user) => !!user && ['admin', 'operator'].includes(user.role);
