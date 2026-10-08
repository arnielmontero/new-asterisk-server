import { h, mount, fmtTime } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { dataTable, select, stateBadge, fmtDuration } from './common.js';
import { playRecordingDialog } from './voicemail.js';

const DISP_CLASS = { ANSWERED: 'online', 'NO ANSWER': 'unknown', BUSY: 'incall', FAILED: 'unknown', CONGESTION: 'unknown' };
const DISP_LABEL = { ANSWERED: 'Answered', 'NO ANSWER': 'No answer', BUSY: 'Busy', FAILED: 'Failed', CONGESTION: 'Congestion' };
const DIR_LABEL = { internal: 'Internal', inbound: 'Inbound', outbound: 'Outbound' };

const toIso = (local) => (local ? new Date(local).toISOString() : '');

export function callsView() {
  const f = { page: 1, pageSize: 50, number: '', direction: '', disposition: '', trunk: '', from: '', to: '', minDuration: '', legs: 'calls' };
  const statsBox = h('div', { class: 'stack' });
  const table = h('div');
  const dialogHost = h('div');
  const pager = h('div', { class: 'pager' });
  let lastTick = store.state.cdrTick;

  const unsubscribe = store.subscribe((s) => {
    if (s.cdrTick !== lastTick) { lastTick = s.cdrTick; load(); }
  });

  const query = (extra = {}) => {
    const qs = new URLSearchParams();
    for (const k of ['number', 'direction', 'disposition', 'trunk', 'minDuration', 'legs']) if (f[k]) qs.set(k, f[k]);
    if (f.from) qs.set('from', toIso(f.from));
    if (f.to) qs.set('to', toIso(f.to));
    for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
    return qs;
  };

  async function load() {
    try {
      const [list, stats] = await Promise.all([
        api('GET', `/cdr?${query({ page: f.page, pageSize: f.pageSize })}`),
        api('GET', `/cdr/stats?${new URLSearchParams([...(f.from ? [['from', toIso(f.from)]] : []), ...(f.to ? [['to', toIso(f.to)]] : [])])}`),
      ]);
      renderStats(stats);
      renderList(list);
    } catch (err) {
      mount(table, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  function bars(rows, labelKey, valueKey, { max } = {}) {
    const top = max || Math.max(1, ...rows.map((r) => r[valueKey]));
    // The page's Content-Security-Policy forbids style attributes; setting the height through the CSS object
    // model is allowed.
    return h('div', { class: 'bars' }, rows.map((r) => {
      const fill = h('div', { class: 'bar-fill' });
      fill.style.height = `${Math.round((r[valueKey] / top) * 100)}%`;
      return h('div', { class: 'bar', title: `${r[labelKey]}: ${r[valueKey]}` }, fill, h('div', { class: 'bar-label' }, String(r[labelKey]).slice(-5)));
    }));
  }

  const card = (title, value, sub) => h('article', { class: 'card online stat' }, h('div', { class: 'ext-name' }, title), h('div', { class: 'ext-number' }, String(value)), sub ? h('div', { class: 'muted small' }, sub) : null);

  function renderStats(s) {
    const t = s.summary;
    mount(
      statsBox,
      h('div', { class: 'cards' },
        card('Calls', t.total), card('Answered', t.answered, t.total ? `${Math.round((t.answered / t.total) * 100)}%` : ''),
        card('Missed / failed', t.missed), card('Average talk time', fmtDuration(t.avg_billsec)), card('Total talk time', fmtDuration(t.total_billsec))),
      t.total ? h('div', { class: 'grid2' },
        h('section', { class: 'panel' }, h('h3', null, 'Calls per day'), bars(s.perDay, 'day', 'calls')),
        h('section', { class: 'panel' }, h('h3', null, 'Calls by hour of day'), bars(s.perHour, 'hour', 'calls')),
        h('section', { class: 'panel' }, h('h3', null, 'Busiest callers'), dataTable(['Number', 'Calls'], s.topSources.map((r) => [r.number || '—', r.calls]), { empty: '—' })),
        h('section', { class: 'panel' }, h('h3', null, 'Most called'), dataTable(['Number', 'Calls'], s.topDestinations.map((r) => [r.number || '—', r.calls]), { empty: '—' }))) : null,
    );
  }

  function renderList({ items, total, page, pageSize }) {
    mount(
      table,
      dataTable(
        ['Time', 'Direction', 'From', 'To', 'Trunk', 'Result', 'Talk time', 'Total', ''],
        items.map((r) => [
          fmtTime(r.start_time),
          DIR_LABEL[r.direction] || r.direction,
          h('span', null, r.src || '—', r.caller_id && /"([^"]+)"/.test(r.caller_id) ? h('span', { class: 'muted small' }, ` ${/"([^"]+)"/.exec(r.caller_id)[1]}`) : null),
          r.dst || '—',
          r.trunk || '',
          stateBadge(DISP_CLASS[r.disposition] || 'offline', DISP_LABEL[r.disposition] || r.disposition || '—'),
          fmtDuration(r.billsec),
          fmtDuration(r.duration),
          r.recording_id ? h('button', { class: 'btn small', 'data-recording': r.recording_id, onclick: () => playRecordingDialog(dialogHost, r.recording_id) }, 'Play recording') : '',
        ]),
        { empty: 'No calls match.' },
      ),
    );
    const pages = Math.max(1, Math.ceil(total / pageSize));
    mount(
      pager,
      h('button', { class: 'btn small', disabled: page <= 1, onclick: () => { f.page -= 1; load(); } }, 'Previous'),
      h('span', null, ` Page ${page} of ${pages} (${total} calls) `),
      h('button', { class: 'btn small', disabled: page >= pages, onclick: () => { f.page += 1; load(); } }, 'Next'),
      h('button', { class: 'btn small', onclick: load }, 'Refresh'),
      h('a', { class: 'btn small', href: `/api/cdr/export.csv?${query()}`, download: 'call-history.csv' }, 'Export CSV'),
    );
  }

  const apply = (key, value) => { f[key] = value; f.page = 1; load(); };
  const filters = h('div', { class: 'filters' },
    h('label', null, 'From', h('input', { type: 'datetime-local', onchange: (e) => apply('from', e.target.value) })),
    h('label', null, 'To', h('input', { type: 'datetime-local', onchange: (e) => apply('to', e.target.value) })),
    h('label', null, 'Number', h('input', { placeholder: 'caller or called number', onchange: (e) => apply('number', e.target.value.trim()) })),
    h('label', null, 'Direction', Object.assign(select([{ value: '', label: 'All' }, { value: 'internal', label: 'Internal' }, { value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }], ''), { onchange: (e) => apply('direction', e.target.value) })),
    h('label', null, 'Result', Object.assign(select([{ value: '', label: 'All' }, { value: 'ANSWERED', label: 'Answered' }, { value: 'NO ANSWER', label: 'No answer' }, { value: 'BUSY', label: 'Busy' }, { value: 'FAILED', label: 'Failed' }, { value: 'CONGESTION', label: 'Congestion' }], ''), { onchange: (e) => apply('disposition', e.target.value) })),
    h('label', null, 'Trunk', h('input', { placeholder: 'trunk name', onchange: (e) => apply('trunk', e.target.value.trim()) })),
    h('label', null, 'Min. talk seconds', h('input', { type: 'number', min: 0, onchange: (e) => apply('minDuration', e.target.value) })),
    h('label', null, 'Show', Object.assign(select([{ value: 'calls', label: 'Calls' }, { value: 'all', label: 'Every leg (technical)' }], 'calls'), { onchange: (e) => apply('legs', e.target.value) })),
  );

  load();
  return {
    el: h('div', { class: 'stack' }, h('h1', null, 'Call history'), statsBox,
      h('section', { class: 'panel' }, filters, table, pager), dialogHost),
    destroy() { unsubscribe(); },
  };
}
