import { h, mount, fmtTime } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { dataTable, fmtDuration, openDialog } from './common.js';

/** True while any player inside `root` is playing: redrawing the list then would cut the sound off. */
const isPlaying = (root) => [...root.querySelectorAll('audio')].some((a) => !a.paused && !a.ended);

/** Runs `load` now, or as soon as the player in `root` stops if one is playing. Returns the guarded function. */
function whenIdle(root, load) {
  let waiting = false;
  const run = () => {
    if (isPlaying(root)) { waiting = true; return Promise.resolve(); }
    waiting = false;
    return load();
  };
  const resume = () => { if (waiting && !isPlaying(root)) run(); };
  root.addEventListener('pause', resume, true);
  root.addEventListener('ended', resume, true);
  return run;
}

/** One voicemail message: who, when, how long, a player, and the usual mark / delete buttons. */
function messageRow(m, { showBox, reload }) {
  const mark = async (heard) => {
    try { await api('PATCH', `/voicemail/${m.id}`, { heard }); await reload(); } catch (err) { store.toast(describeError(err)); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this message? It cannot be recovered.')) return;
    try { await api('DELETE', `/voicemail/${m.id}`); await reload(); } catch (err) { store.toast(describeError(err)); }
  };
  const audio = h('audio', { controls: true, preload: 'none', src: `/api/voicemail/${m.id}/audio`, class: 'player', 'aria-label': 'Voicemail message' });
  // Listening to a message is what marks it as heard.
  // The row is updated in place, so the sound keeps playing; the list is redrawn once the player stops.
  audio.addEventListener('play', async () => {
    if (m.heard) return;
    m.heard = true;
    try {
      await api('PATCH', `/voicemail/${m.id}`, { heard: true });
      row.classList.remove('unread');
      row.querySelector('.vm-new')?.remove();
    } catch (err) { m.heard = false; store.toast(describeError(err)); }
  }, { once: true });
  const row = h('div', { class: `vm-row${m.heard ? '' : ' unread'}`, 'data-message': m.id },
    h('div', { class: 'vm-meta' },
      showBox ? h('strong', null, `Box ${m.extension}  `) : null,
      h('strong', null, m.caller || 'Unknown caller'),
      h('span', { class: 'muted small' }, `  ${fmtTime(m.created_at)} · ${fmtDuration(m.duration_secs)}`),
      m.heard ? null : h('span', { class: 'badge incall vm-new' }, 'NEW')),
    audio,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', onclick: () => mark(!m.heard) }, m.heard ? 'Mark as new' : 'Mark as heard'),
      h('button', { class: 'btn small danger', onclick: remove }, 'Delete')));
  return row;
}

/** Dashboard panel: the messages in the signed-in person's own voicemail box. Hidden when voicemail is not switched on. */
export function buildMyVoicemail() {
  const el = h('section', { class: 'panel', id: 'my-voicemail', hidden: true });
  let loadedFor = null;
  let lastTick = -1;
  const loadWhenIdle = whenIdle(el, () => load());

  async function load() {
    try {
      const res = await api('GET', '/voicemail');
      const mine = store.state.user?.extension;
      const unread = res.unread[mine] || 0;
      el.hidden = false;
      mount(
        el,
        h('h2', null, `Voicemail (box ${mine})`, unread ? h('span', { class: 'badge incall vm-count', id: 'vm-unread' }, `${unread} new`) : null),
        res.messages.length
          ? h('div', { class: 'stack' }, res.messages.map((m) => messageRow(m, { showBox: false, reload: load })))
          : h('p', { class: 'muted small', id: 'vm-empty' }, 'No messages. Callers who reach you when you are busy, away or unreachable can leave one here (if voicemail is on for your extension).'),
      );
    } catch (err) {
      el.hidden = true;
      if (err.status && err.status !== 403) store.toast(describeError(err));
    }
  }

  return {
    el,
    update(s) {
      const eligible = !!s.user && ['admin', 'operator'].includes(s.user.role) && !!s.user.extension;
      if (!eligible) { el.hidden = true; return; }
      if (loadedFor !== s.user.extension || lastTick !== s.voicemailTick) {
        loadedFor = s.user.extension;
        lastTick = s.voicemailTick;
        loadWhenIdle();
      }
    },
  };
}

/** Administrator page: every call recording and every voicemail box. */
export function recordingsView() {
  const dialogHost = h('div');
  const recBox = h('section', { class: 'panel' });
  const vmBox = h('section', { class: 'panel' });
  const f = { page: 1, pageSize: 25, number: '', from: '', to: '' };
  let lastTick = store.state.voicemailTick;
  let vmFilter = '';

  const loadMessagesWhenIdle = whenIdle(vmBox, () => loadMessages());
  const unsubscribe = store.subscribe((s) => {
    if (s.voicemailTick !== lastTick) { lastTick = s.voicemailTick; loadMessagesWhenIdle(); }
  });

  const toIso = (local) => (local ? new Date(local).toISOString() : '');
  const query = () => {
    const qs = new URLSearchParams({ page: String(f.page), pageSize: String(f.pageSize) });
    if (f.number) qs.set('number', f.number);
    if (f.from) qs.set('from', toIso(f.from));
    if (f.to) qs.set('to', toIso(f.to));
    return qs;
  };

  async function loadRecordings() {
    try {
      const res = await api('GET', `/recordings?${query()}`);
      const pages = Math.max(1, Math.ceil(res.total / res.pageSize));
      const apply = (key, value) => { f[key] = value; f.page = 1; loadRecordings(); };
      mount(
        recBox,
        h('h2', null, 'Call recordings'),
        h('p', { class: 'muted small' }, 'Calls are recorded when recording is switched on for an extension or a trunk (Extensions and Trunks pages). Only the conversation is recorded, not ringing or menus. Recording calls may require telling the people on the call; check the rules that apply to you. Listening to and deleting a recording is written to the audit log.'),
        h('div', { class: 'filters' },
          h('label', null, 'From', h('input', { type: 'datetime-local', onchange: (e) => apply('from', e.target.value) })),
          h('label', null, 'To', h('input', { type: 'datetime-local', onchange: (e) => apply('to', e.target.value) })),
          h('label', null, 'Number', h('input', { placeholder: 'caller or called number', value: f.number, onchange: (e) => apply('number', e.target.value.trim()) }))),
        dataTable(
          ['Time', 'From', 'To', 'Length', 'Recording', ''],
          res.items.map((r) => [
            fmtTime(r.started_at), r.src || '—', r.dst || '—', fmtDuration(r.duration_secs),
            h('audio', { controls: true, preload: 'none', src: `/api/recordings/${r.id}/audio`, class: 'player', 'aria-label': 'Call recording' }),
            h('div', { class: 'row-actions' },
              h('a', { class: 'btn small', href: `/api/recordings/${r.id}/audio`, download: `call-${r.id}.wav` }, 'Download'),
              h('button', { class: 'btn small danger', onclick: () => remove(r) }, 'Delete')),
          ]),
          { empty: 'No recordings yet.' },
        ),
        h('div', { class: 'pager' },
          h('button', { class: 'btn small', disabled: res.page <= 1, onclick: () => { f.page -= 1; loadRecordings(); } }, 'Previous'),
          h('span', null, ` Page ${res.page} of ${pages} (${res.total} recordings) `),
          h('button', { class: 'btn small', disabled: res.page >= pages, onclick: () => { f.page += 1; loadRecordings(); } }, 'Next'),
          h('button', { class: 'btn small', onclick: loadRecordings }, 'Refresh')),
      );
    } catch (err) {
      mount(recBox, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  async function remove(r) {
    if (!window.confirm('Delete this recording? It cannot be recovered.')) return;
    try {
      await api('DELETE', `/recordings/${r.id}`);
      store.toast('Recording deleted', 'info');
      await loadRecordings();
    } catch (err) { store.toast(describeError(err)); }
  }

  async function loadMessages() {
    try {
      const res = await api('GET', `/voicemail${vmFilter ? `?extension=${encodeURIComponent(vmFilter)}` : ''}`);
      const boxes = Object.entries(res.unread).filter(([, n]) => n > 0).map(([ext, n]) => `${ext}: ${n} new`).join(' · ');
      mount(
        vmBox,
        h('h2', null, 'Voicemail'),
        h('p', { class: 'muted small' }, 'All voicemail boxes. People also see their own messages on their dashboard.', boxes ? ` Unread: ${boxes}.` : ''),
        h('label', { class: 'inline-field' }, 'Box ', h('input', {
          placeholder: 'all', value: vmFilter, maxlength: 6, size: 8, inputmode: 'numeric',
          onchange: (e) => { vmFilter = e.target.value.trim().replace(/\D/g, ''); loadMessages(); },
        })),
        res.messages.length
          ? h('div', { class: 'stack' }, res.messages.map((m) => messageRow(m, { showBox: true, reload: loadMessages })))
          : h('p', { class: 'muted' }, 'No messages.'),
      );
    } catch (err) {
      mount(vmBox, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  loadRecordings();
  loadMessages();
  return { el: h('div', { class: 'stack' }, h('h1', null, 'Voicemail & recordings'), recBox, vmBox, dialogHost), destroy() { unsubscribe(); } };
}

/** A small dialog with a player, used from the call history. */
export function playRecordingDialog(host, recordingId) {
  openDialog(host, {
    title: 'Call recording',
    build: ({ close }) => h('div', { class: 'stack' },
      h('audio', { controls: true, autoplay: true, src: `/api/recordings/${recordingId}/audio`, class: 'player wide-player', 'aria-label': 'Call recording' }),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'))),
  });
}
