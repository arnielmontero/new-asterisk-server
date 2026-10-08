import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { field, check, dataTable, openDialog, nullIfEmpty, stateBadge } from './common.js';

/** Administrator page: create rooms, see who is in each one right now, and mute, kick or lock. */
export function conferencesView() {
  const dialogHost = h('div');
  const box = h('section', { class: 'panel', id: 'conferences-panel' });
  let rooms = [];
  let live = { available: false, rooms: [] };
  let lastTick = store.state.conferenceTick;
  let timer = null;

  const unsubscribe = store.subscribe((s) => {
    if (s.conferenceTick !== lastTick) { lastTick = s.conferenceTick; refreshLive(); }
  });

  async function load() {
    try {
      rooms = (await api('GET', '/pbx/conferences')).conferences;
      await refreshLive();
    } catch (err) {
      mount(box, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  async function refreshLive() {
    try { live = await api('GET', '/pbx/conferences/status'); } catch { /* keep the last values */ }
    render();
  }

  async function control(room, action, channel) {
    try {
      await api('POST', `/pbx/conferences/${room.id}/${action}`, channel ? { channel } : undefined);
      await refreshLive();
    } catch (err) { store.toast(describeError(err)); await refreshLive(); }
  }

  const who = (p) => {
    const label = p.extension ? `${p.extension}${p.name ? ` ${p.name}` : ''}` : (p.name || p.caller || 'Unknown caller');
    return h('span', null, label, p.extension ? null : (p.caller && p.name ? h('span', { class: 'muted small' }, ` ${p.caller}`) : null));
  };

  function render() {
    mount(
      box,
      h('div', { class: 'section-head' }, h('h2', null, 'Conference rooms'),
        h('button', { class: 'btn primary', id: 'add-conference', onclick: () => edit(null) }, 'Add room')),
      h('p', { class: 'muted small' }, 'Anyone who dials the room number joins it (after the PIN, if the room has one). Whoever enters the administrator PIN can also mute, kick and lock from the phone keypad: 1 mute yourself, 2 lock or unlock the room, 3 remove the last person who joined. You can do the same here. A room is also a destination for inbound routes, menus and schedules.'),
      !live.available ? h('p', { class: 'banner warn' }, 'Live room state is unavailable (telephony system not connected).') : null,
      dataTable(
        ['Room', 'Name', 'Protection', 'In the room now', ''],
        rooms.map((r) => {
          const l = live.rooms.find((x) => x.number === r.number);
          return [
            h('strong', null, r.number),
            r.name,
            h('span', { class: 'muted small' }, [r.pin ? 'PIN' : 'open', r.admin_pin ? 'administrator PIN' : null, r.mute_on_join ? 'muted on entry' : null, r.max_members ? `max ${r.max_members}` : null].filter(Boolean).join(', ')),
            l && l.parties
              ? h('div', { class: 'stack', 'data-room': r.number },
                  l.locked ? stateBadge('incall', 'LOCKED') : null,
                  l.participants.map((p) => h('div', { class: 'order-row', 'data-channel': p.channel },
                    who(p),
                    p.admin ? stateBadge('paging', 'admin') : null,
                    p.muted ? stateBadge('offline', 'muted') : (p.talking ? stateBadge('online', 'talking') : null),
                    h('button', { class: 'btn small', onclick: () => control(r, p.muted ? 'unmute' : 'mute', p.channel) }, p.muted ? 'Unmute' : 'Mute'),
                    h('button', { class: 'btn small danger', onclick: () => control(r, 'kick', p.channel) }, 'Remove'))))
              : h('span', { class: 'muted small' }, r.enabled ? 'empty' : 'disabled'),
            h('div', { class: 'row-actions' },
              l && l.parties ? h('button', { class: 'btn small', onclick: () => control(r, l.locked ? 'unlock' : 'lock') }, l.locked ? 'Unlock' : 'Lock') : null,
              h('button', { class: 'btn small', onclick: () => edit(r) }, 'Edit'),
              h('button', { class: 'btn small danger', onclick: () => remove(r) }, 'Delete')),
          ];
        }),
        { empty: 'No conference rooms yet.' },
      ),
    );
  }

  function edit(r) {
    const creating = !r;
    openDialog(dialogHost, {
      title: creating ? 'Add conference room' : `Edit room ${r.number}`,
      build: ({ close, showError }) => {
        const f = {
          number: h('input', { required: true, inputmode: 'numeric', pattern: '[0-9]{3,6}', placeholder: 'e.g. 900', value: r?.number || '', disabled: !creating }),
          name: h('input', { required: true, maxlength: 40, placeholder: 'e.g. Team meeting', value: r?.name || '' }),
          pin: h('input', { inputmode: 'numeric', pattern: '[0-9]{3,10}', maxlength: 10, placeholder: 'none: anyone can join', value: r?.pin || '', autocomplete: 'off' }),
          admin: h('input', { inputmode: 'numeric', pattern: '[0-9]{3,10}', maxlength: 10, placeholder: 'none', value: r?.admin_pin || '', autocomplete: 'off' }),
          mute: h('input', { type: 'checkbox', checked: r ? r.mute_on_join : false }),
          max: h('input', { type: 'number', min: 0, max: 200, value: r?.max_members ?? 0 }),
          enabled: h('input', { type: 'checkbox', checked: r ? r.enabled : true }),
        };
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = {
              name: f.name.value.trim(), pin: nullIfEmpty(f.pin.value), admin_pin: nullIfEmpty(f.admin.value),
              mute_on_join: f.mute.checked, max_members: Number(f.max.value) || 0, enabled: f.enabled.checked,
            };
            try {
              if (creating) await api('POST', '/pbx/conferences', { number: f.number.value.trim(), ...body });
              else await api('PATCH', `/pbx/conferences/${r.id}`, body);
              store.toast('Conference room saved', 'info');
              close();
              await load();
            } catch (err) { showError(err); }
          },
        },
        h('div', { class: 'form-grid' }, field('Number', f.number, creating ? 'Dial this to join. 3 to 6 digits.' : null), field('Name', f.name)),
        h('div', { class: 'form-grid' },
          field('PIN to join (digits)', f.pin, 'Callers press the PIN, then # .'),
          field('Administrator PIN (digits)', f.admin, 'Joins with the right to mute, lock and remove others. Must differ from the PIN.')),
        h('div', { class: 'form-grid' },
          field('Most people at once', f.max, '0 = no limit'),
          check(f.mute, 'Mute people when they join', '(they unmute with key 1)')),
        check(f.enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  async function remove(r) {
    if (!window.confirm(`Delete conference room ${r.number} (${r.name})?`)) return;
    try {
      await api('DELETE', `/pbx/conferences/${r.id}`);
      store.toast('Room deleted', 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  load();
  timer = setInterval(refreshLive, 5000);
  return { el: h('div', { class: 'stack' }, h('h1', null, 'Conferences'), box, dialogHost), destroy() { clearInterval(timer); unsubscribe(); } };
}

/** Dashboard panel: the rooms anyone with a phone may join, with how many are in each, and a Join button. */
export function buildConferenceRooms(softphone) {
  const el = h('section', { class: 'panel', id: 'conference-rooms', hidden: true });
  let loadedFor = null;
  let lastTick = -1;

  async function load() {
    try {
      const { rooms } = await api('GET', '/conference-rooms');
      el.hidden = rooms.length === 0;
      if (!rooms.length) return;
      mount(
        el,
        h('h2', null, 'Conference rooms'),
        h('div', { class: 'stack' }, rooms.map((r) => h('div', { class: 'order-row', 'data-room': r.number },
          h('span', null, h('strong', null, `${r.number} ${r.name}`), `  ${r.parties} in the room`, r.locked ? '  (locked)' : '', r.protected ? '  (PIN)' : ''),
          h('button', {
            class: 'btn small', onclick: async () => {
              try { await softphone.call(r.number); } catch (err) { if (!store.state.call) store.toast(err.message); }
            },
          }, 'Join')))),
        r0Hint(rooms),
      );
    } catch { el.hidden = true; }
  }
  const r0Hint = (rooms) => (rooms.some((r) => r.protected) ? h('p', { class: 'muted small' }, 'After you join, a short tone asks for the PIN: use the on-screen keypad, then #.') : null);

  return {
    el,
    update(s) {
      const eligible = !!s.user && ['admin', 'operator'].includes(s.user.role);
      if (!eligible) { el.hidden = true; return; }
      if (loadedFor !== s.user.username || lastTick !== s.conferenceTick) {
        loadedFor = s.user.username;
        lastTick = s.conferenceTick;
        load();
      }
    },
  };
}
