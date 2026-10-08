import { h, mount } from '../dom.js';
import { store } from '../store.js';

/** Dashboard panel: calls waiting in the parking slots, with a countdown and a Pick up button (dials the slot). */
export function buildParked(softphone) {
  const el = h('section', { class: 'panel', id: 'parked-calls', hidden: true });
  let timer = null;
  let key = '';

  function draw(s) {
    const parked = s.parked || [];
    el.hidden = parked.length === 0;
    if (!parked.length) { clearInterval(timer); timer = null; key = ''; return; }
    if (!timer) timer = setInterval(() => draw(store.state), 1000);
    const ready = ['admin', 'operator'].includes(s.user?.role) && !!s.user?.extension && s.sip.state === 'registered' && !s.call;
    const next = JSON.stringify([parked.map((p) => [p.slot, Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))]), ready]);
    if (next === key) return;
    key = next;
    mount(
      el,
      h('h2', null, 'Parked calls'),
      h('div', { class: 'stack' }, parked.map((p) => {
        const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
        return h('div', { class: 'order-row', 'data-slot': p.slot },
          h('span', null, h('strong', null, `Slot ${p.slot}`), `  ${p.name && p.name !== p.caller ? `${p.name} ` : ''}${p.caller || 'unknown caller'}`,
            p.parkedBy ? `  parked by ${p.parkedBy}` : '', h('span', { class: 'muted small' }, `  rings back in ${left}s`)),
          h('button', {
            class: 'btn small primary', 'data-pickup-slot': p.slot, disabled: !ready,
            title: ready ? 'Take this call' : 'You need a registered softphone and no call in progress',
            onclick: () => softphone.call(p.slot).catch((err) => store.toast(err.message)),
          }, 'Pick up'));
      })),
    );
  }

  return {
    el,
    update: draw,
    destroy() { clearInterval(timer); timer = null; },
  };
}
