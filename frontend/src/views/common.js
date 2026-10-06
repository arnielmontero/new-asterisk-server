import { h, mount } from '../dom.js';
import { describeError } from '../api.js';

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
