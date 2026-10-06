import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';

/** A labelled form control with optional help text. */
export const field = (label, input, hint) =>
  h('label', null, label, input, hint ? h('small', { class: 'muted' }, hint) : null);

export const check = (input, text, hint) =>
  h('label', { class: 'check' }, input, ' ', text, hint ? h('small', { class: 'muted' }, ` ${hint}`) : null);

export function select(options, value) {
  const el = h('select', null, options.map((o) => h('option', { value: o.value }, o.label)));
  if (value !== undefined && value !== null) el.value = value;
  return el;
}

/** Table with a header row; `rows` are arrays of cells (strings or nodes). */
export function dataTable(headers, rows, { empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) return h('p', { class: 'muted' }, empty);
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data' },
      h('thead', null, h('tr', null, headers.map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((cells) => h('tr', null, cells.map((c) => h('td', null, c)))))));
}

export function stateBadge(state, text) {
  return h('span', { class: `badge ${state}` }, text || state);
}

/**
 * Modal dialog. `build(close)` returns the form content; the dialog is mounted into `host`.
 * Returns the close function.
 */
export function openDialog(host, { title, wide = false, build }) {
  const close = () => mount(host);
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const showError = (err) => { error.textContent = typeof err === 'string' ? err : describeError(err); error.hidden = false; };
  const content = build({ close, showError, clearError: () => { error.hidden = true; } });
  mount(
    host,
    h('div', { class: 'overlay', onclick: (e) => { if (e.target.classList.contains('overlay')) close(); } },
      h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
        h('h2', null, title), content, error)),
  );
  return close;
}

export const splitList = (text) => String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

export const nullIfEmpty = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };

/** Copy text to the clipboard; falls back to selecting the text when the Clipboard API is unavailable. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const fmtDuration = (s) => {
  const n = Number(s) || 0;
  const hh = Math.floor(n / 3600); const mm = Math.floor((n % 3600) / 60); const ss = n % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};

// ------------------------------------------------------------- destinations
// A destination is where a call goes next: { type, value }. One picker is used by every form that routes calls.

export async function loadDestinationData() {
  const [e, g, t, i, a] = await Promise.all([api('GET', '/pbx/extensions'), api('GET', '/pbx/ring-groups'), api('GET', '/pbx/time-conditions'), api('GET', '/pbx/ivrs'), api('GET', '/pbx/announcements')]);
  return { extensions: e.extensions, ringGroups: g.groups, timeConditions: t.conditions, ivrs: i.ivrs, announcements: a.announcements };
}

export const describeDestination = (d, data) => {
  if (!d) return 'Hang up';
  if (d.type === 'extension') { const x = data?.extensions?.find((e) => e.number === d.value); return `Extension ${d.value}${x ? ` ${x.display_name}` : ''}`; }
  if (d.type === 'ringgroup') { const x = data?.ringGroups?.find((e) => e.number === d.value); return `Ring group ${d.value}${x ? ` ${x.name}` : ''}`; }
  if (d.type === 'timecondition') { const x = data?.timeConditions?.find((e) => String(e.id) === d.value); return `Time condition ${x ? x.name : d.value}`; }
  if (d.type === 'ivr') { const x = data?.ivrs?.find((e) => e.number === d.value); return `Menu ${d.value}${x ? ` ${x.name}` : ''}`; }
  if (d.type === 'announcement') { const x = data?.announcements?.find((e) => String(e.id) === d.value); return `Announcement ${x ? x.name : d.value}`; }
  if (d.type === 'echo') return 'Echo test';
  return `Reject${d.value ? ` (${d.value})` : ''}`;
};

/**
 * Two linked selects: what kind of destination, then which one. `allowNone` adds a "nothing" choice that yields null.
 * Returns { el, get() }.
 */
export function destinationPicker(data, { value = null, allowNone = false, noneLabel = 'Nothing (hang up)', exclude = null } = {}) {
  const types = [
    ...(allowNone ? [{ value: '', label: noneLabel }] : []),
    { value: 'extension', label: 'Extension' },
    ...(data.ringGroups?.length ? [{ value: 'ringgroup', label: 'Ring group' }] : []),
    ...(data.timeConditions?.length ? [{ value: 'timecondition', label: 'Time condition' }] : []),
    ...(data.ivrs?.length ? [{ value: 'ivr', label: 'Menu (IVR)' }] : []),
    ...(data.announcements?.length ? [{ value: 'announcement', label: 'Announcement' }] : []),
    { value: 'echo', label: 'Echo test' },
    { value: 'hangup', label: 'Reject / busy tone' },
  ];
  const typeSel = select(types, value?.type || types[0].value);
  const valSel = h('select');
  const options = (type) => {
    if (type === 'extension') return data.extensions.filter((x) => `extension:${x.number}` !== exclude).map((x) => ({ value: x.number, label: `${x.number} ${x.display_name}` }));
    if (type === 'ringgroup') return data.ringGroups.filter((x) => `ringgroup:${x.number}` !== exclude).map((x) => ({ value: x.number, label: `${x.number} ${x.name}` }));
    if (type === 'ivr') return data.ivrs.filter((x) => `ivr:${x.number}` !== exclude).map((x) => ({ value: x.number, label: `${x.number} ${x.name}` }));
    if (type === 'announcement') return data.announcements.filter((x) => `announcement:${x.id}` !== exclude).map((x) => ({ value: String(x.id), label: x.name }));
    if (type === 'timecondition') return data.timeConditions.filter((x) => `timecondition:${x.id}` !== exclude).map((x) => ({ value: String(x.id), label: x.name }));
    if (type === 'hangup') return [{ value: 'reject', label: 'Rejected' }, { value: 'busy', label: 'Busy tone' }, { value: 'congestion', label: 'Congestion tone' }];
    return [];
  };
  const draw = () => {
    const opts = options(typeSel.value);
    mount(valSel, opts.map((o) => h('option', { value: o.value }, o.label)));
    valSel.hidden = opts.length === 0;
  };
  draw();
  if (value?.value) valSel.value = value.type === 'hangup' && !value.value ? 'reject' : value.value;
  typeSel.addEventListener('change', draw);
  return {
    el: h('div', { class: 'dest-picker' }, typeSel, valSel),
    get() {
      if (!typeSel.value) return null;
      if (typeSel.value === 'echo') return { type: 'echo', value: '' };
      return { type: typeSel.value, value: typeSel.value === 'hangup' && valSel.value === 'reject' ? '' : valSel.value };
    },
  };
}
