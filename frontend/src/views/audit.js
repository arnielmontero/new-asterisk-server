import { h, mount, fmtTime } from '../dom.js';
import { api, describeError } from '../api.js';

export function auditView() {
  const filters = { page: 1, pageSize: 25, action: '', username: '', status: '' };
  const table = h('div', { class: 'table-wrap' });
  const pager = h('div', { class: 'pager' });

  const action = h('input', { placeholder: 'action, e.g. paging.request', onchange: (e) => { filters.action = e.target.value.trim(); filters.page = 1; load(); } });
  const username = h('input', { placeholder: 'username', onchange: (e) => { filters.username = e.target.value.trim(); filters.page = 1; load(); } });
  const status = h('select', { onchange: (e) => { filters.status = e.target.value; filters.page = 1; load(); } },
    h('option', { value: '' }, 'any status'), h('option', { value: 'success' }, 'success'), h('option', { value: 'failure' }, 'failure'));

  async function load() {
    const qs = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
    for (const k of ['action', 'username', 'status']) if (filters[k]) qs.set(k, filters[k]);
    try {
      const data = await api('GET', `/audit?${qs}`);
      render(data);
    } catch (err) {
      mount(table, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  function render({ items, total, page, pageSize }) {
    mount(
      table,
      h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Time', 'User', 'Action', 'Target', 'IP', 'Status', 'Details'].map((t) => h('th', null, t)))),
        h('tbody', null, items.map((r) =>
          h('tr', { class: r.status === 'failure' ? 'fail' : '' },
            h('td', null, fmtTime(r.timestamp)),
            h('td', null, r.username || '—'),
            h('td', null, r.action),
            h('td', null, r.target || ''),
            h('td', null, r.ip_address || ''),
            h('td', null, h('span', { class: `status ${r.status}` }, r.status)),
            h('td', { class: 'details' }, r.details ? JSON.stringify(r.details) : ''))))),
      items.length ? null : h('p', { class: 'muted' }, 'No matching audit records.'),
    );
    const pages = Math.max(1, Math.ceil(total / pageSize));
    mount(
      pager,
      h('button', { class: 'btn small', disabled: page <= 1, onclick: () => { filters.page -= 1; load(); } }, 'Previous'),
      h('span', null, ` Page ${page} of ${pages} (${total} records) `),
      h('button', { class: 'btn small', disabled: page >= pages, onclick: () => { filters.page += 1; load(); } }, 'Next'),
      h('button', { class: 'btn small', onclick: load }, 'Refresh'),
    );
  }

  load();
  return {
    el: h('div', { class: 'stack' }, h('h1', null, 'Audit log'),
      h('section', { class: 'panel' }, h('div', { class: 'filters' }, action, username, status), table, pager)),
    destroy() {},
  };
}
