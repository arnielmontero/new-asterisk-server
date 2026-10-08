import { io } from 'socket.io-client';
import { h, mount } from './dom.js';
import { api, setUnauthorizedHandler, describeError } from './api.js';
import { store, canUseSoftphone } from './store.js';
import { Softphone } from './softphone.js';
import { loginView } from './views/login.js';
import { setupView } from './views/setup.js';
import { dashboardView } from './views/dashboard.js';
import { usersView } from './views/users.js';
import { auditView } from './views/audit.js';
import { systemView } from './views/system.js';
import { extensionsView } from './views/extensions.js';
import { trunksView } from './views/trunks.js';
import { routesView } from './views/routes.js';
import { callsView } from './views/calls.js';
import { callflowView } from './views/callflow.js';
import { menusView } from './views/menus.js';
import { recordingsView } from './views/voicemail.js';
import { conferencesView } from './views/conferences.js';

const root = document.getElementById('app');
const audioEl = document.getElementById('remote-audio');
const softphone = new Softphone(audioEl);

let socket = null;
let current = null; // the active view: { destroy }
let refreshTimer = null;
let healthTimer = null;

const ROUTES = {
  '#/': { admin: false, view: () => dashboardView({ softphone }) },
  '#/extensions': { admin: true, view: () => extensionsView() },
  '#/trunks': { admin: true, view: () => trunksView() },
  '#/routes': { admin: true, view: () => routesView() },
  '#/callflow': { admin: true, view: () => callflowView() },
  '#/menus': { admin: true, view: () => menusView() },
  '#/calls': { admin: true, view: () => callsView() },
  '#/recordings': { admin: true, view: () => recordingsView() },
  '#/conferences': { admin: true, view: () => conferencesView() },
  '#/users': { admin: true, view: () => usersView() },
  '#/audit': { admin: true, view: () => auditView() },
  '#/system': { admin: true, view: () => systemView() },
};

// ---------------------------------------------------------------------- toasts
// Lives outside the app shell so errors are visible on every screen, including login.
const toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });
document.body.appendChild(toastHost);
let toastKey = '';
function renderToasts(s) {
  const key = s.toasts.map((t) => t.id).join(',');
  if (key === toastKey) return;
  toastKey = key;
  mount(toastHost, s.toasts.map((t) => h('div', { class: `toast ${t.kind}`, role: t.kind === 'error' ? 'alert' : 'status' }, t.message)));
}

// ----------------------------------------------------------------------- shell
// A stable frame: header + banners are refreshed in place, the view container is only touched on navigation.
let chrome = null;
let chromeKey = '';

function buildChrome() {
  chrome = { header: h('header', { class: 'topbar' }), banners: h('div'), view: h('main', { id: 'view' }) };
  chrome.el = h('div', { class: 'shell' }, chrome.header, chrome.banners, chrome.view);
  mount(root, chrome.el);
  chromeKey = '';
}

function chromeSignature(s) {
  return JSON.stringify([s.user?.username, s.user?.role, s.sip, s.socketConnected, s.backendOk, s.ami?.state, pbxChip(s)?.text, location.hash]);
}

// Configuration changes are applied to Asterisk in the background; admins see when that is done or failed.
function pbxChip(s) {
  if (s.user?.role !== 'admin' || !s.pbx) return null;
  if (s.pbx.last && !s.pbx.last.ok) return { cls: 'bad', text: 'PBX config ERROR', title: s.pbx.last.error || '' };
  if (s.pbx.pending || !s.pbx.inSync) return { cls: 'sip-registering', text: 'PBX config applying…', title: '' };
  return null;
}

function renderChrome() {
  const s = store.state;
  const { user } = s;
  if (!user || !chrome) return;
  const here = location.hash || '#/';
  const navLink = (href, label) => h('a', { href, class: here === href ? 'active' : '' }, label);

  const sipLabel = { idle: '—', registering: 'registering…', registered: `registered (${user.extension})`, failed: 'NOT registered' }[s.sip.state] || s.sip.state;
  mount(
    chrome.header,
    h('div', { class: 'brand' }, 'LAN Communications'),
    h('nav', null, navLink('#/', 'Dashboard'),
      user.role === 'admin' ? [navLink('#/extensions', 'Extensions'), navLink('#/trunks', 'Trunks'), navLink('#/routes', 'Routes'), navLink('#/callflow', 'Call flow'), navLink('#/conferences', 'Conferences'), navLink('#/menus', 'Menus & audio'), navLink('#/calls', 'Call history'), navLink('#/recordings', 'Voicemail & recordings'), navLink('#/users', 'Users'), navLink('#/audit', 'Audit log'), navLink('#/system', 'System')] : null),
    h('div', { class: 'who' },
      canUseSoftphone(user) ? h('span', { class: `status-chip sip-${s.sip.state}`, id: 'chip-sip', title: s.sip.reason || '' }, `SIP ${sipLabel}`) : null,
      h('span', { class: `status-chip ${s.backendOk && s.socketConnected ? 'ok' : 'bad'}`, id: 'chip-server' },
        !s.backendOk ? 'Server unreachable' : s.socketConnected ? 'Live' : 'Reconnecting…'),
      (() => { const c = pbxChip(s); return c ? h('span', { class: `status-chip ${c.cls}`, id: 'chip-pbx', title: c.title }, c.text) : null; })(),
      user.role === 'admin' && s.ami
        ? h('span', { class: `status-chip ${s.ami.state === 'connected' ? 'ok' : 'bad'}`, id: 'chip-ami' }, `Telephony ${s.ami.state === 'connected' ? 'connected' : 'DISCONNECTED'}`)
        : null,
      h('span', { class: 'user' }, `${user.username} `, h('span', { class: `role ${user.role}` }, user.role)),
      h('button', { class: 'btn small', id: 'logout', onclick: logout }, 'Sign out')),
  );
  mount(
    chrome.banners,
    !s.backendOk ? h('div', { class: 'banner warn', role: 'alert' }, 'Cannot reach the server. Retrying automatically…') : null,
    user.role === 'admin' && s.ami && s.ami.state !== 'connected'
      ? h('div', { class: 'banner warn', role: 'alert' }, 'The telephony system (Asterisk AMI) is disconnected. Extension state is unknown and calls/pages cannot be started until it reconnects.')
      : null,
  );
}

function renderApp() {
  const s = store.state;
  if (!s.user) return;
  const route = ROUTES[location.hash] || ROUTES['#/'];
  if (route.admin && s.user.role !== 'admin') { location.hash = '#/'; return; }
  if (!chrome || !chrome.el.isConnected) buildChrome();
  current?.destroy?.();
  current = route.view();
  mount(chrome.view, current.el);
  renderChrome();
  chromeKey = chromeSignature(s);
}

store.subscribe((s) => {
  renderToasts(s);
  if (!s.user || !chrome || !chrome.el.isConnected) return;
  const key = chromeSignature(s);
  if (key === chromeKey) return;
  chromeKey = key;
  renderChrome();
});

window.addEventListener('hashchange', () => { if (store.state.user && chrome?.el.isConnected) renderApp(); });

// ------------------------------------------------------------------- lifecycle
function showScreen(view) {
  current?.destroy?.();
  chrome = null;
  current = view;
  mount(root, view.el);
}

function showLogin() {
  showScreen(loginView({ onLoggedIn: (user) => start(user) }));
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch { /* cookie is cleared server-side when reachable */ }
  teardown();
  showLogin();
}

function teardown() {
  clearInterval(refreshTimer);
  clearInterval(healthTimer);
  softphone.stop();
  socket?.close();
  socket = null;
  store.set({
    user: null, extensions: [], page: null, ami: null, trunks: [], pbx: null, sip: { state: 'idle', reason: '' },
    call: null, incoming: null, audioReady: false, audioBlocked: false, socketConnected: false,
  });
}

setUnauthorizedHandler(() => {
  if (!store.state.user) return;
  teardown();
  showLogin();
  store.toast('Your session has ended. Please sign in again.');
});

function connectSocket() {
  socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });
  socket.on('connect', () => store.set({ socketConnected: true }));
  socket.on('disconnect', () => {
    store.set({ socketConnected: false });
    api('GET', '/auth/me').catch(() => {}); // find out whether the whole backend is unreachable
  });
  socket.on('connect_error', (err) => {
    store.set({ socketConnected: false });
    if (store.state.backendOk) api('GET', '/auth/me').catch(() => {});
    // If the session is gone this call returns 401 and the unauthorised handler logs out.
    if (err.message === 'unauthorized') api('GET', '/auth/me').catch(() => {});
  });
  const patchExt = (ext) => store.set({ extensions: store.state.extensions.map((e) => (e.extension === ext.extension ? ext : e)) });
  socket.on('extension.snapshot', (list) => store.set({ extensions: list }));
  socket.on('extension.status.changed', patchExt);
  socket.on('paging.started', (page) => store.set({ page }));
  socket.on('paging.ended', () => store.set({ page: null }));
  socket.on('paging.failed', (p) => {
    store.set({ page: null });
    if (p.username === store.state.user?.username) store.toast(`Page failed: ${humanReason(p.reason)}`);
  });
  socket.on('trunk.snapshot', (trunks) => store.set({ trunks }));
  socket.on('pbx.apply', (pbx) => store.set({ pbx }));
  socket.on('cdr.new', () => store.set({ cdrTick: store.state.cdrTick + 1 }));
  socket.on('conference.changed', () => store.set({ conferenceTick: store.state.conferenceTick + 1 }));
  socket.on('voicemail.changed', () => store.set({ voicemailTick: store.state.voicemailTick + 1 }));
  socket.on('ami.snapshot', (ami) => store.set({ ami }));
  socket.on('ami.connected', (ami) => store.set({ ami }));
  socket.on('ami.disconnected', (ami) => store.set({ ami }));
}

function humanReason(reason) {
  if (reason === 'no_call_received') return 'your phone never placed the call (is your softphone registered and the microphone enabled?)';
  if (String(reason).startsWith('denied:')) return 'the phone system refused the page';
  return reason;
}

async function start(user) {
  store.set({ user });
  try {
    const info = await api('GET', '/extensions');
    store.set({ extensions: info.extensions, pagingGroups: info.pagingGroups, echoExtension: info.echoExtension });
  } catch (err) {
    store.toast(describeError(err));
  }
  connectSocket();
  clearInterval(refreshTimer);
  // Sliding session: renew the short-lived access cookie every 5 minutes.
  refreshTimer = setInterval(() => api('POST', '/auth/refresh').catch(() => {}), 5 * 60 * 1000);
  // While the backend is unreachable keep probing so the banner clears on its own.
  clearInterval(healthTimer);
  healthTimer = setInterval(() => { if (!store.state.backendOk || !store.state.socketConnected) api('GET', '/auth/me').catch(() => {}); }, 5000);

  if (canUseSoftphone(user) && !store.state.audioReady) {
    showScreen(setupView({ user, onReady: () => { store.set({ audioReady: true }); beginApp(user); } }));
    return;
  }
  beginApp(user);
}

async function beginApp(user) {
  renderApp();
  if (!canUseSoftphone(user)) return;
  try {
    const cfg = await api('GET', '/sip/config');
    if (cfg.configured) await softphone.start(cfg);
  } catch (err) {
    store.set({ sip: { state: 'failed', reason: describeError(err) } });
  }
}

(async function boot() {
  try {
    const { user } = await api('GET', '/auth/me');
    await start(user);
  } catch (err) {
    if (err.status === 401) {
      showLogin();
    } else {
      showScreen({
        el: h('div', { class: 'login-wrap' }, h('div', { class: 'login-card' },
          h('h1', null, 'Server unavailable'),
          h('p', { class: 'form-error' }, describeError(err)),
          h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again'))),
      });
      setTimeout(() => location.reload(), 8000);
    }
  }
}());
