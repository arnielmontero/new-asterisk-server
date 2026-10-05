import { h, mount, fmtTime } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';

const fmtUptime = (s) => {
  if (s == null) return 'unknown';
  const d = Math.floor(s / 86400); const hr = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return `${d ? `${d}d ` : ''}${hr}h ${m}m`;
};

export function systemView() {
  const body = h('div', { class: 'stack' });
  let timer = null;

  async function load() {
    try {
      const s = await api('GET', '/system/status');
      const amiOk = s.ami.state === 'connected';
      mount(
        body,
        h('div', { class: 'cards' },
          row('Backend', 'ok', `v${s.backend.version}, up ${fmtUptime(s.backend.uptimeSeconds)}`),
          row('Database', s.database.status === 'ok' ? 'ok' : 'down', s.database.status),
          row('Asterisk AMI', amiOk ? 'ok' : 'down',
            `${s.ami.state} (${s.ami.host}:${s.ami.port})${amiOk ? '' : ` – reconnect attempt ${s.ami.reconnectAttempt}`}`),
          row('Asterisk', s.asterisk ? 'ok' : 'down', s.asterisk ? `${s.asterisk.version || 'unknown version'}, up ${fmtUptime(s.asterisk.uptimeSeconds)}` : 'not reachable'),
          row('Live updates', store.state.socketConnected ? 'ok' : 'down', store.state.socketConnected ? 'connected' : 'reconnecting'),
          row('Active page', s.page ? 'info' : 'ok', s.page ? `${s.page.name} (${s.page.status}) by ${s.page.username || s.page.extension}` : 'none')),
        h('section', { class: 'panel' }, h('h2', null, 'Extensions'),
          h('table', { class: 'data' },
            h('thead', null, h('tr', null, ['Extension', 'State', 'Browser client', 'Phone'].map((t) => h('th', null, t)))),
            h('tbody', null, s.extensions.map((x) => h('tr', null,
              h('td', null, `${x.extension} ${x.name}`), h('td', null, x.state), h('td', null, x.clients.browser ? 'registered' : '—'), h('td', null, x.clients.phone ? 'registered' : '—')))))),
        h('p', { class: 'muted small' }, `Last AMI connect: ${fmtTime(s.ami.lastConnectedAt) || 'never'}. Refreshes every 5 seconds.`),
      );
    } catch (err) {
      mount(body, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  function row(title, state, text) {
    return h('article', { class: `card ${state === 'ok' ? 'online' : state === 'info' ? 'paging' : 'offline'}` },
      h('div', { class: 'ext-name' }, title),
      h('span', { class: `badge ${state === 'ok' ? 'online' : state === 'info' ? 'paging' : 'offline'}` }, state === 'ok' ? 'OK' : state === 'info' ? 'ACTIVE' : 'PROBLEM'),
      h('p', { class: 'small' }, text));
  }

  load();
  timer = setInterval(load, 5000);
  return { el: h('div', { class: 'stack' }, h('h1', null, 'System status'), body), destroy() { clearInterval(timer); } };
}
