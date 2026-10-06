import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';
import { store, canUseSoftphone, canControlCalls } from '../store.js';

const STATE_CLASS = { Online: 'online', Offline: 'offline', 'In-Call': 'incall', Paging: 'paging', Unknown: 'unknown' };

export function dashboardView({ softphone }) {
  const cards = h('div', { class: 'cards' });
  const paging = h('section', { class: 'panel', id: 'paging-panel' });
  const phone = buildPhonePanel(softphone);
  const callFrom = { value: null }; // used when the admin has no extension of their own

  const extPanel = h('section', { class: 'panel' }, h('h2', null, 'Extensions'), cards);
  const mine = buildMyHandling();
  const el = h('div', { class: 'dashboard' }, extPanel, paging, phone.el, mine.el);

  function renderCards(s) {
    const user = s.user;
    const mine = user.extension;
    const needsFrom = canControlCalls(user) && !mine;
    const fromSelect = needsFrom
      ? h(
          'label',
          { class: 'inline-field' },
          'Ring extension ',
          h('select', { onchange: (e) => { callFrom.value = e.target.value || null; } },
            h('option', { value: '' }, 'choose…'),
            s.extensions.map((x) => h('option', { value: x.extension }, `${x.extension} ${x.name}`))),
          ' and connect to the extension you click',
        )
      : null;

    mount(
      cards,
      fromSelect,
      s.extensions.map((x) => {
        const busy = x.state === 'In-Call' || x.state === 'Paging';
        const canCall = canControlCalls(user) && (mine ? mine !== x.extension : true);
        return h(
          'article',
          { class: `card ${STATE_CLASS[x.state] || 'unknown'}`, 'data-extension': x.extension },
          h('div', { class: 'card-head' },
            h('div', null, h('div', { class: 'ext-number' }, x.extension), h('div', { class: 'ext-name' }, x.name)),
            h('span', { class: `badge ${STATE_CLASS[x.state] || 'unknown'}`, 'data-state': x.state }, x.state)),
          h('div', { class: 'chips' },
            h('span', { class: `chip ${x.clients?.browser ? 'on' : ''}` }, 'Browser'),
            h('span', { class: `chip ${x.clients?.phone ? 'on' : ''}` }, 'Phone')),
          x.state === 'Unknown' ? h('p', { class: 'muted small' }, 'Telephony system is not connected, so the live state cannot be shown.') : null,
          canControlCalls(user)
            ? h('div', { class: 'actions' },
                h('button', {
                  class: 'btn',
                  disabled: !canCall || x.state !== 'Online',
                  title: x.state !== 'Online' ? `${x.name} is ${x.state}` : '',
                  onclick: () => originate(mine || callFrom.value, x.extension),
                }, 'Call'),
                h('button', {
                  class: 'btn danger',
                  disabled: !busy,
                  onclick: () => hangupExt(x.extension),
                }, 'Hang up'))
            : null,
        );
      }),
    );
  }

  async function originate(from, to) {
    if (!from) { store.toast('Choose which extension to ring first'); return; }
    try {
      const res = await api('POST', '/originate', { from, to });
      store.toast(res.message, 'info');
    } catch (err) {
      store.toast(describeError(err));
    }
  }

  async function hangupExt(extension) {
    try {
      await api('POST', '/hangup', { extension });
    } catch (err) {
      store.toast(describeError(err));
    }
  }

  async function startPage(group) {
    try {
      await api('POST', '/page', { group }); // backend: JWT, role, group, concurrency, audit
    } catch (err) {
      store.toast(describeError(err));
      return;
    }
    try {
      await softphone.call(group, { paging: group }); // your microphone is the live audio source
    } catch (err) {
      store.toast(err?.message || 'Could not start the page');
    }
  }

  function renderPaging(s) {
    const user = s.user;
    const sip = s.sip.state;
    const myPage = s.call && s.call.paging && s.call.direction === 'out';
    const live = s.page && s.page.status === 'live' ? s.page : null;
    const eligible = canControlCalls(user);
    const ready = canUseSoftphone(user) && sip === 'registered' && s.audioReady;
    const blockedWhy = !eligible ? 'Paging is not available for your role.'
      : !user.extension ? 'No extension is assigned to your account, so there is no microphone to page from.'
      : !s.audioReady ? 'Enable the microphone first.'
      : sip !== 'registered' ? 'Your softphone is not registered yet.'
      : s.call && !myPage ? 'Finish your current call first.'
      : live && !myPage ? `A page to ${live.name} is in progress.`
      : null;

    mount(
      paging,
      h('h2', null, 'Paging'),
      live
        ? h('div', { class: 'banner paging' },
            myPage ? `You are on air: ${live.name}. Everything you say is broadcast; recipients cannot reply.` : `Page in progress: ${live.name}${live.username ? ` (by ${live.username})` : ''}`)
        : null,
      eligible
        ? h('div', { class: 'page-buttons' },
            (s.pagingGroups.length ? s.pagingGroups : [{ number: '700', name: 'Page All' }, { number: '701', name: 'Page Office' }, { number: '702', name: 'Page Warehouse' }]).map((g) =>
              h('button', {
                class: 'btn page',
                'data-group': g.number,
                disabled: !ready || !!blockedWhy,
                title: blockedWhy || `Broadcast your voice to ${g.name.replace('Page ', '')}`,
                onclick: () => startPage(g.number),
              }, g.name)))
        : null,
      myPage ? h('button', { class: 'btn danger big', id: 'end-page', onclick: () => softphone.hangup() }, 'End page') : null,
      !myPage && live && user.role === 'admin'
        ? h('button', { class: 'btn danger', onclick: () => api('DELETE', '/page').catch((e) => store.toast(describeError(e))) }, 'Force end page')
        : null,
      blockedWhy ? h('p', { class: 'muted small' }, blockedWhy) : h('p', { class: 'muted small' }, 'Press a button, then speak. The page ends when you press End page.'),
    );
  }

  function update(s) {
    if (!s.user) return;
    mine.update(s);
    renderCards(s);
    renderPaging(s);
    phone.update(s);
  }

  const unsubscribe = store.subscribe(update);
  update(store.state);
  return { el, destroy: unsubscribe };
}

// ------------------------------------------------------------------ softphone
function buildPhonePanel(softphone) {
  const dial = h('input', { id: 'dial', type: 'text', inputmode: 'tel', pattern: '[0-9*#+]*', maxlength: '24', placeholder: 'Extension or number', autocomplete: 'off', 'aria-label': 'Extension or phone number to call' });
  const status = h('div', { class: 'sip-status' });
  const body = h('div', { class: 'phone-body' });
  const call = h('div', { class: 'call-state' });
  const el = h('section', { class: 'panel', id: 'softphone' }, h('h2', null, 'Softphone'), status, body, call);

  const doCall = async (number) => {
    try { await softphone.call(number); } catch (err) { if (!store.state.call) store.toast(err.message); }
  };
  dial.addEventListener('keydown', (e) => { if (e.key === 'Enter' && dial.value) doCall(dial.value); });
  dial.addEventListener('input', () => { dial.value = dial.value.replace(/[^0-9*#+]/g, ''); });

  const dialRow = h('div', { class: 'dial-row' },
    dial,
    h('button', { class: 'btn primary', id: 'dial-call', onclick: () => dial.value && doCall(dial.value) }, 'Call'),
    h('button', { class: 'btn', id: 'echo-test', onclick: () => doCall(store.state.echoExtension) }, 'Echo test (600)'));

  function update(s) {
    const user = s.user;
    if (!canControlCalls(user)) {
      mount(status, h('p', { class: 'muted' }, 'Your role is read-only: you can watch extension status but not place calls or pages.'));
      mount(body); mount(call);
      return;
    }
    if (!user.extension) {
      mount(status, h('p', { class: 'muted' }, 'No extension is assigned to your account. Ask an administrator to assign an extension to enable the softphone.'));
      mount(body); mount(call);
      return;
    }
    const sip = s.sip;
    const label = { idle: 'Not started', registering: 'Registering…', registered: `Registered as ${user.extension}`, failed: 'Not registered' }[sip.state] || sip.state;
    mount(
      status,
      h('div', { class: 'sip-line' },
        h('span', { class: `dot ${sip.state}` }),
        h('strong', null, `SIP: ${label}`),
        sip.state === 'failed' ? h('button', { class: 'btn small', onclick: () => softphone.retry() }, 'Retry') : null),
      sip.reason ? h('p', { class: 'form-error' }, sip.reason) : null,
      s.audioBlocked
        ? h('div', { class: 'banner warn' }, 'The browser blocked audio playback. ',
            h('button', { class: 'btn small', onclick: () => softphone.playRemote() }, 'Click to enable sound'))
        : null,
    );

    // Keep the dial input element alive (and focused) across updates.
    const ready = sip.state === 'registered' && !s.call;
    dial.disabled = !ready;
    dialRow.querySelectorAll('button').forEach((b) => { b.disabled = !ready; });
    if (body.firstChild !== dialRow) mount(body, dialRow);

    const c = s.call;
    if (!c) { mount(call, h('p', { class: 'muted small' }, 'No active call.')); return; }
    const who = c.paging ? `Page ${c.paging}` : c.peer;
    const stateText = { calling: 'Calling…', ringing: c.direction === 'in' ? 'Incoming call' : 'Ringing…', connecting: 'Connecting…', connected: 'Connected' }[c.state] || c.state;
    mount(
      call,
      h('div', { class: `banner ${c.state === 'connected' ? 'ok' : 'info'}`, id: 'call-banner' },
        h('strong', null, c.direction === 'in' ? `From ${who}` : `To ${who}`), ` – ${stateText}`,
        c.paging && c.direction === 'in' && c.state === 'connected' ? ' (listen only)' : ''),
      h('div', { class: 'actions' },
        s.incoming
          ? [h('button', { class: 'btn primary', id: 'answer', onclick: () => softphone.answer() }, 'Answer'),
             h('button', { class: 'btn danger', id: 'reject', onclick: () => softphone.reject() }, 'Reject')]
          : [c.state === 'connected' && !c.paging ? h('button', { class: 'btn', id: 'mute', onclick: () => softphone.toggleMute() }, c.muted ? 'Unmute' : 'Mute') : null,
             h('button', { class: 'btn danger', id: 'hangup', onclick: () => softphone.hangup() }, c.paging && c.direction === 'out' ? 'End page' : 'Hang up')]),
    );
  }

  return { el, update };
}

// ---------------------------------------------------------- my call handling
// Do not disturb and "forward all calls" for the signed-in person's own extension.
function buildMyHandling() {
  const el = h('section', { class: 'panel', id: 'my-handling', hidden: true });
  let loadedFor = null;
  let settings = null;

  async function load(number) {
    try {
      settings = (await api('GET', '/my/extension')).extension;
      draw();
    } catch (err) {
      mount(el, h('p', { class: 'form-error' }, describeError(err)));
    }
    loadedFor = number;
  }

  async function save(patch) {
    try {
      settings = { ...settings, ...(await api('PATCH', '/my/extension', patch)).extension };
      store.toast('Saved', 'info');
    } catch (err) {
      store.toast(describeError(err));
    }
    draw();
  }

  function draw() {
    if (!settings) return;
    const others = store.state.extensions.filter((x) => x.extension !== settings.number);
    const fwd = h('select', { id: 'my-forward', onchange: (e) => save({ fwd_all: e.target.value ? { type: 'extension', value: e.target.value } : null }) },
      h('option', { value: '' }, 'No forwarding'),
      others.map((x) => h('option', { value: x.extension }, `${x.extension} ${x.name}`)));
    fwd.value = settings.fwd_all?.type === 'extension' ? settings.fwd_all.value : '';
    mount(
      el,
      h('h2', null, `My calls (extension ${settings.number})`),
      settings.dnd ? h('div', { class: 'banner warn' }, 'Do not disturb is ON: callers get a busy signal and your phones do not ring.') : null,
      h('div', { class: 'actions' },
        h('button', { class: `btn ${settings.dnd ? 'danger' : ''}`, id: 'my-dnd', onclick: () => save({ dnd: !settings.dnd }) }, settings.dnd ? 'Turn do not disturb off' : 'Turn do not disturb on')),
      h('label', { class: 'inline-field' }, 'Forward all my calls to ', fwd),
    );
  }

  return {
    el,
    update(s) {
      const eligible = !!s.user && ['admin', 'operator'].includes(s.user.role) && !!s.user.extension;
      el.hidden = !eligible;
      if (eligible && loadedFor !== s.user.extension) { loadedFor = s.user.extension; load(s.user.extension); }
    },
  };
}
