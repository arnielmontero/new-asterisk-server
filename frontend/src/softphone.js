import { UserAgent, Registerer, RegistererState, Inviter, SessionState } from 'sip.js';
import { store } from './store.js';
import { isPagingInvite } from './paging-detect.js';
import { startRingtone, stopRingtone } from './ringtone.js';

const MEDIA = { audio: true, video: false };

/**
 * WebRTC softphone built on SIP.js 0.21.2.
 *
 * - registers the operator's extension over WSS (Nginx :443 -> Asterisk ws :8088)
 * - places and receives normal two-way calls (manual answer for ordinary calls)
 * - auto-answers ONLY genuine pages (see paging-detect.js) and keeps the
 *   microphone muted for recipients (Asterisk additionally mutes them server-side)
 * - the operator's microphone is the live audio source of a page: a page is just a
 *   call from this client to 700/701/702 after the backend authorised it
 */
export class Softphone {
  constructor(audioEl) {
    this.audioEl = audioEl;
    this.ua = null;
    this.registerer = null;
    this.session = null; // the one active Inviter / Invitation
    this.config = null;
    this.stopped = true;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  // ------------------------------------------------------------ registration
  async start(config) {
    this.config = config;
    this.stopped = false;
    store.set({ sip: { state: 'registering', reason: '' } });

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const uri = UserAgent.makeURI(`sip:${config.username}@${config.domain}`);
    this.ua = new UserAgent({
      uri,
      displayName: config.displayName,
      authorizationUsername: config.username,
      authorizationPassword: config.password,
      transportOptions: { server: `${scheme}://${location.host}/ws`, connectionTimeout: 8 },
      // LAN only: host candidates, no STUN/TURN.
      sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: [] } },
      logLevel: 'warn',
      delegate: {
        onInvite: (invitation) => this.onInvite(invitation),
        onDisconnect: (err) => this.onTransportDown(err),
        onConnect: () => this.onTransportUp(),
      },
    });

    try {
      await this.ua.start();
    } catch (err) {
      this.fail(`Could not connect to the phone system (${err?.message || 'WebSocket error'})`);
      this.scheduleReconnect();
      return;
    }
    this.register();
  }

  register() {
    this.registerer = new Registerer(this.ua, { expires: 300 });
    this.registerer.stateChange.addListener((state) => {
      if (state === RegistererState.Registered) {
        this.reconnectAttempt = 0;
        store.set({ sip: { state: 'registered', reason: '' } });
      } else if (state === RegistererState.Unregistered && !this.stopped && store.state.sip.state === 'registered') {
        store.set({ sip: { state: 'failed', reason: 'Registration was lost' } });
        this.scheduleReconnect();
      }
    });
    this.registerer
      .register({
        requestDelegate: {
          onReject: (response) => {
            const code = response.message.statusCode;
            const why = code === 401 || code === 403 ? 'the phone system rejected the extension credentials' : `${code} ${response.message.reasonPhrase}`;
            this.fail(`SIP registration failed: ${why}`);
          },
        },
      })
      .catch((err) => this.fail(`SIP registration failed: ${err?.message || 'no response'}`));
  }

  fail(reason) {
    store.set({ sip: { state: 'failed', reason } });
  }

  onTransportUp() {
    if (this.stopped) return;
    if (store.state.sip.state === 'failed' || store.state.sip.state === 'registering') this.register();
  }

  onTransportDown(err) {
    if (this.stopped) return;
    store.set({ sip: { state: 'failed', reason: err ? `Connection to the phone system lost (${err.message})` : 'Connection to the phone system lost' } });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        store.set({ sip: { state: 'registering', reason: '' } });
        await this.ua.reconnect();
      } catch (err) {
        this.fail(`Still cannot reach the phone system (${err?.message || 'offline'}); retrying`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Manual retry button. */
  async retry() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    if (!this.config) return;
    await this.stop();
    await this.start(this.config);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.session && (await this.hangup());
      await this.registerer?.unregister().catch(() => {});
      await this.ua?.stop();
    } catch { /* shutting down */ }
    this.ua = null;
    this.registerer = null;
    store.set({ sip: { state: 'idle', reason: '' }, call: null, incoming: null });
  }

  // ------------------------------------------------------------------- calls
  /** Send a DTMF key on the active call (answering menus, conference PINs). Returns false when there is no call. */
  sendDtmf(tone) {
    const sdh = this.session?.sessionDescriptionHandler;
    if (!sdh || typeof sdh.sendDtmf !== 'function' || !/^[0-9*#A-D]$/.test(String(tone))) return false;
    return !!sdh.sendDtmf(String(tone));
  }

  /** Place a normal call (or, with `paging`, the SIP leg of an authorised page). */
  async call(number, { paging = null } = {}) {
    if (this.session) throw new Error('You are already in a call');
    if (store.state.sip.state !== 'registered') throw new Error('Your phone is not registered yet');
    if (!/^[0-9*#+]{2,24}$/.test(number)) throw new Error('Enter an extension or a phone number (digits, *, # or +)');

    // "#" is not allowed unescaped in the user part of a SIP URI.
    const target = UserAgent.makeURI(`sip:${number.replace(/#/g, '%23')}@${this.config.domain}`);
    const inviter = new Inviter(this.ua, target, { sessionDescriptionHandlerOptions: { constraints: MEDIA } });
    this.track(inviter, { direction: 'out', peer: number, paging });
    store.set({ call: { direction: 'out', peer: number, state: 'calling', paging, muted: false } });
    try {
      await inviter.invite({
        requestDelegate: {
          onProgress: () => this.setCall({ state: 'ringing' }),
          onReject: (response) => {
            const code = response.message.statusCode;
            const reason = {
              403: paging ? 'The page was not authorised' : 'Forbidden',
              404: 'No such extension',
              480: 'Not available',
              486: 'Busy',
              487: 'Call cancelled',
              603: 'Declined',
            }[code] || `${code} ${response.message.reasonPhrase}`;
            this.callFailed(`Call failed: ${reason}`);
          },
        },
      });
    } catch (err) {
      this.callFailed(micMessage(err) || `Call failed: ${err?.message || 'unknown error'}`);
      throw err;
    }
  }

  async answer() {
    const s = this.session;
    if (!s || store.state.incoming === null) return;
    stopRingtone();
    try {
      await s.accept({ sessionDescriptionHandlerOptions: { constraints: MEDIA } });
      store.set({ incoming: null });
    } catch (err) {
      store.toast(micMessage(err) || `Could not answer: ${err?.message}`);
      this.cleanup();
    }
  }

  async reject() {
    const s = this.session;
    if (!s || store.state.incoming === null) return;
    stopRingtone();
    try { await s.reject({ statusCode: 603 }); } catch { /* already gone */ }
    this.cleanup();
  }

  async hangup() {
    const s = this.session;
    if (!s) return;
    stopRingtone();
    try {
      if (s.state === SessionState.Established) await s.bye();
      else if (s instanceof Inviter) await s.cancel();
      else await s.reject({ statusCode: 603 });
    } catch { /* the far end may have hung up already */ }
    this.cleanup();
  }

  toggleMute() {
    const pc = this.session?.sessionDescriptionHandler?.peerConnection;
    if (!pc) return;
    const muted = !store.state.call?.muted;
    pc.getSenders().forEach((sender) => { if (sender.track) sender.track.enabled = !muted; });
    this.setCall({ muted });
  }

  // ---------------------------------------------------------------- incoming
  onInvite(invitation) {
    const from = invitation.remoteIdentity.uri.user;
    if (this.session) {
      invitation.reject({ statusCode: 486 }).catch(() => {});
      return;
    }
    const paging = isPagingInvite({
      callerUser: from,
      pagingHeader: invitation.request.getHeader('X-Paging-Call'),
      callInfoHeader: invitation.request.getHeader('Call-Info'),
    });

    this.track(invitation, { direction: 'in', peer: from, paging: paging ? from : null });
    if (paging) {
      // Genuine page: answer without interaction (microphone permission was granted at setup).
      store.set({ call: { direction: 'in', peer: from, state: 'connecting', paging: from, muted: true }, incoming: null });
      invitation
        .accept({ sessionDescriptionHandlerOptions: { constraints: MEDIA } })
        .catch((err) => {
          store.toast(micMessage(err) || 'Could not answer the page');
          this.cleanup();
        });
      return;
    }
    // Ordinary call: ring and wait for the user.
    store.set({ call: { direction: 'in', peer: from, state: 'ringing', paging: null, muted: false }, incoming: { from } });
    startRingtone();
  }

  // ----------------------------------------------------------------- session
  track(session, meta) {
    this.session = session;
    session.stateChange.addListener((state) => {
      if (this.session !== session) return;
      if (state === SessionState.Established) this.onEstablished(meta);
      else if (state === SessionState.Terminated) {
        stopRingtone();
        const wasPage = !!store.state.call?.paging;
        this.cleanup();
        if (wasPage && meta.direction === 'in') store.toast('Page ended', 'info');
      }
    });
  }

  onEstablished(meta) {
    stopRingtone();
    const handler = this.session.sessionDescriptionHandler;
    const pc = handler.peerConnection;
    const stream = new MediaStream();
    pc.getReceivers().forEach((r) => r.track && stream.addTrack(r.track));
    this.audioEl.srcObject = stream;
    this.playRemote();
    // Page recipients must not transmit: keep their microphone muted locally too.
    const listenOnly = meta.direction === 'in' && !!meta.paging;
    if (listenOnly) pc.getSenders().forEach((s) => { if (s.track) s.track.enabled = false; });
    this.setCall({ state: 'connected', muted: listenOnly ? true : false });
    store.set({ incoming: null });
  }

  /** audio.play() can be rejected by autoplay policy: surface it so the user can unblock it. */
  playRemote() {
    const p = this.audioEl.play();
    if (p && typeof p.then === 'function') {
      p.then(() => store.set({ audioBlocked: false })).catch(() => store.set({ audioBlocked: true }));
    }
  }

  setCall(patch) {
    if (store.state.call) store.set({ call: { ...store.state.call, ...patch } });
  }

  callFailed(message) {
    store.toast(message);
    this.cleanup();
  }

  cleanup() {
    this.session = null;
    this.audioEl.srcObject = null;
    store.set({ call: null, incoming: null });
  }
}

function micMessage(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone access was denied. Allow the microphone for this site in the browser address bar and try again.';
  if (n === 'NotFoundError') return 'No microphone was found on this device.';
  return null;
}
