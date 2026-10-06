import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { field, check, dataTable, openDialog, nullIfEmpty, select, stateBadge } from './common.js';

const DEST_TYPES = [
  { value: 'extension', label: 'Ring an extension' },
  { value: 'echo', label: 'Echo test (callers hear themselves)' },
  { value: 'hangup', label: 'Reject the call' },
];

const PATTERN_PRESETS = [
  { label: 'Local 7-digit (dial 9 + number)', patterns: ['_9XXXXXXX'], strip: 1, prepend: '' },
  { label: 'National (dial 9 + 10 digits)', patterns: ['_9NXXNXXXXXX'], strip: 1, prepend: '' },
  { label: 'International (dial 900 + number)', patterns: ['_900X.'], strip: 3, prepend: '+' },
  { label: 'Everything starting with 9', patterns: ['_9X.'], strip: 1, prepend: '' },
];

const describeDest = (d) => {
  if (d.type === 'extension') return `Extension ${d.value}`;
  if (d.type === 'echo') return 'Echo test';
  return `Reject${d.value ? ` (${d.value})` : ''}`;
};

export function routesView() {
  const dialogHost = h('div');
  const inBox = h('section', { class: 'panel' });
  const outBox = h('section', { class: 'panel' });
  let inbound = [];
  let outbound = [];
  let trunks = [];
  let extensions = [];

  async function load() {
    try {
      const [i, o, t, e] = await Promise.all([
        api('GET', '/pbx/inbound-routes'), api('GET', '/pbx/outbound-routes'), api('GET', '/pbx/trunks'), api('GET', '/pbx/extensions')]);
      inbound = i.routes; outbound = o.routes; trunks = t.trunks; extensions = e.extensions;
      renderInbound();
      renderOutbound();
    } catch (err) {
      mount(inBox, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  // -------------------------------------------------------------------- inbound
  function renderInbound() {
    mount(
      inBox,
      h('div', { class: 'section-head' },
        h('h2', null, 'Inbound routes (phone numbers)'),
        h('button', { class: 'btn primary', id: 'add-inbound', onclick: () => editInbound(null), disabled: !trunks.length }, 'Add inbound route')),
      h('p', { class: 'muted small' }, 'Decide where a call to one of your phone numbers (a DID) goes. Calls to a number with no route follow the trunk’s default (set on the Trunks page), otherwise they are rejected.'),
      !trunks.length ? h('p', { class: 'banner info' }, 'Add a trunk first.') : null,
      dataTable(
        ['Name', 'Number (DID)', 'Trunk', 'Goes to', 'Status', ''],
        inbound.map((r) => [
          h('strong', null, r.name), h('code', null, r.did === '*' ? 'any number' : r.did), r.trunk_name || 'all trunks', describeDest(r.destination),
          r.enabled ? stateBadge('online', 'Enabled') : stateBadge('offline', 'Disabled'),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small', onclick: () => editInbound(r) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => remove('inbound-routes', r) }, 'Delete')),
        ]),
        { empty: 'No inbound routes yet.' },
      ),
    );
  }

  function editInbound(r) {
    const creating = !r;
    openDialog(dialogHost, {
      title: creating ? 'Add inbound route' : `Edit inbound route "${r.name}"`,
      build: ({ close, showError }) => {
        const f = {
          name: h('input', { required: true, maxlength: 60, placeholder: 'e.g. Main line', value: r?.name || '' }),
          did: h('input', { required: true, placeholder: 'e.g. 15551234567, or * for any number', value: r?.did || '' }),
          trunk: select([{ value: '', label: 'All trunks' }, ...trunks.map((t) => ({ value: String(t.id), label: t.display_name }))], r?.trunk_id ? String(r.trunk_id) : ''),
          dest: select(DEST_TYPES, r?.destination.type || 'extension'),
          ext: select(extensions.map((e) => ({ value: e.number, label: `${e.number} ${e.display_name}` })), r?.destination.type === 'extension' ? r.destination.value : extensions[0]?.number),
          reason: select([{ value: 'reject', label: 'Rejected' }, { value: 'busy', label: 'Busy tone' }, { value: 'congestion', label: 'Congestion tone' }], r?.destination.type === 'hangup' ? r.destination.value || 'reject' : 'reject'),
          prefix: h('input', { maxlength: 30, placeholder: 'e.g. Sales  (shown before the caller name)', value: r?.cid_name_prefix || '' }),
          enabled: h('input', { type: 'checkbox', checked: r ? r.enabled : true }),
        };
        const sync = () => { f.ext.hidden = f.dest.value !== 'extension'; f.reason.hidden = f.dest.value !== 'hangup'; };
        f.dest.addEventListener('change', sync);
        setTimeout(sync, 0);
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const type = f.dest.value;
            const body = {
              name: f.name.value.trim(),
              did: f.did.value.trim(),
              trunk_id: f.trunk.value ? Number(f.trunk.value) : null,
              destination: { type, value: type === 'extension' ? f.ext.value : type === 'hangup' ? f.reason.value : '' },
              cid_name_prefix: nullIfEmpty(f.prefix.value),
              enabled: f.enabled.checked,
            };
            try {
              if (creating) await api('POST', '/pbx/inbound-routes', body);
              else await api('PATCH', `/pbx/inbound-routes/${r.id}`, body);
              store.toast('Inbound route saved', 'info');
              close();
              await load();
            } catch (err) { showError(err); }
          },
        },
        field('Name', f.name),
        field('Number (DID)', f.did, 'Exactly as your provider sends it (digits, optionally +). * matches any number. Advanced: an Asterisk pattern such as _555XXXX.'),
        field('Applies to', f.trunk),
        field('Send the call to', f.dest), f.ext, f.reason,
        field('Caller name prefix', f.prefix),
        check(f.enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  // ------------------------------------------------------------------- outbound
  function renderOutbound() {
    mount(
      outBox,
      h('div', { class: 'section-head' },
        h('h2', null, 'Outbound routes (calls to the outside)'),
        h('button', { class: 'btn primary', id: 'add-outbound', onclick: () => editOutbound(null), disabled: !trunks.length }, 'Add outbound route')),
      h('p', { class: 'muted small' }, 'When an extension dials a number that matches a route’s pattern, the call goes out through the route’s trunks, trying them in order until one works. Only extensions marked "may place outbound calls" can use a route (except emergency routes).'),
      dataTable(
        ['Name', 'Dial patterns', 'Digits', 'Trunks (in order)', 'Status', ''],
        outbound.map((r) => [
          h('div', null, h('strong', null, r.name), r.emergency ? h('div', null, stateBadge('unknown', 'EMERGENCY')) : null),
          h('code', null, r.patterns.join('  ')),
          `${r.strip ? `strip ${r.strip}` : 'keep all'}${r.prepend ? `, add ${r.prepend}` : ''}`,
          r.trunks.map((t) => t.name).join(' → '),
          r.enabled ? stateBadge('online', 'Enabled') : stateBadge('offline', 'Disabled'),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small', onclick: () => editOutbound(r) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => remove('outbound-routes', r) }, 'Delete')),
        ]),
        { empty: 'No outbound routes yet: extensions cannot call outside numbers.' },
      ),
    );
  }

  function editOutbound(r) {
    const creating = !r;
    openDialog(dialogHost, {
      title: creating ? 'Add outbound route' : `Edit outbound route "${r.name}"`,
      wide: true,
      build: ({ close, showError }) => {
        const f = {
          name: h('input', { required: true, maxlength: 60, placeholder: 'e.g. National calls', value: r?.name || '' }),
          patterns: h('textarea', { rows: 3, required: true, placeholder: '_9NXXNXXXXXX' }, (r?.patterns || []).join('\n')),
          strip: h('input', { type: 'number', min: 0, max: 20, value: r?.strip ?? 0 }),
          prepend: h('input', { placeholder: 'e.g. +1 (optional)', value: r?.prepend || '' }),
          cid: h('input', { placeholder: 'optional', value: r?.cid_num || '' }),
          position: h('input', { type: 'number', min: 0, max: 10000, value: r?.position ?? 0 }),
          emergency: h('input', { type: 'checkbox', checked: r ? r.emergency : false }),
          enabled: h('input', { type: 'checkbox', checked: r ? r.enabled : true }),
          preset: select([{ value: '', label: 'Fill in from a template...' }, ...PATTERN_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))], ''),
        };
        f.preset.addEventListener('change', () => {
          const p = PATTERN_PRESETS[Number(f.preset.value)];
          if (!p) return;
          f.patterns.value = p.patterns.join('\n'); f.strip.value = p.strip; f.prepend.value = p.prepend;
        });

        let chosen = (r?.trunks || []).map((t) => t.id);
        const trunkList = h('div', { class: 'stack' });
        const addSel = h('select');
        const drawTrunks = () => {
          mount(trunkList,
            chosen.length ? chosen.map((id, i) => {
              const t = trunks.find((x) => x.id === id);
              return h('div', { class: 'order-row' }, h('span', null, `${i + 1}. ${t ? t.display_name : id}`),
                h('button', { class: 'btn small', type: 'button', disabled: i === 0, onclick: () => { [chosen[i - 1], chosen[i]] = [chosen[i], chosen[i - 1]]; drawTrunks(); } }, '↑'),
                h('button', { class: 'btn small', type: 'button', disabled: i === chosen.length - 1, onclick: () => { [chosen[i + 1], chosen[i]] = [chosen[i], chosen[i + 1]]; drawTrunks(); } }, '↓'),
                h('button', { class: 'btn small danger', type: 'button', onclick: () => { chosen = chosen.filter((x) => x !== id); drawTrunks(); } }, 'Remove'));
            }) : h('p', { class: 'muted small' }, 'No trunk chosen yet.'));
          mount(addSel, h('option', { value: '' }, 'Add a trunk...'), trunks.filter((t) => !chosen.includes(t.id)).map((t) => h('option', { value: String(t.id) }, t.display_name)));
        };
        addSel.addEventListener('change', () => { if (addSel.value) { chosen.push(Number(addSel.value)); drawTrunks(); } });
        drawTrunks();

        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = {
              name: f.name.value.trim(),
              patterns: f.patterns.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
              strip: Number(f.strip.value) || 0,
              prepend: f.prepend.value.trim(),
              cid_num: nullIfEmpty(f.cid.value),
              position: Number(f.position.value) || 0,
              emergency: f.emergency.checked,
              enabled: f.enabled.checked,
              trunks: chosen,
            };
            try {
              if (creating) await api('POST', '/pbx/outbound-routes', body);
              else await api('PATCH', `/pbx/outbound-routes/${r.id}`, body);
              store.toast('Outbound route saved', 'info');
              close();
              await load();
            } catch (err) { showError(err); }
          },
        },
        field('Name', f.name),
        field('Template', f.preset),
        field('Dial patterns (one per line)', f.patterns, 'N = 2-9, X = any digit, Z = 1-9, . = one or more further digits. Start with _ for patterns, e.g. _9X.'),
        h('div', { class: 'form-grid' },
          field('Remove leading digits', f.strip, 'e.g. 1 removes the "9" used to reach an outside line'),
          field('Add leading digits', f.prepend),
          field('Caller ID for this route', f.cid),
          field('Order', f.position, 'Lower numbers are checked first')),
        h('div', null, h('strong', null, 'Trunks (tried in this order)'), trunkList, addSel),
        check(f.emergency, 'Emergency route', '(works for every extension, even those not allowed to dial out)'),
        check(f.enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  async function remove(kind, r) {
    if (!window.confirm(`Delete route "${r.name}"?`)) return;
    try {
      await api('DELETE', `/pbx/${kind}/${r.id}`);
      store.toast('Route deleted', 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  load();
  return { el: h('div', { class: 'stack' }, h('h1', null, 'Routes'), inBox, outBox, dialogHost), destroy() {} };
}
