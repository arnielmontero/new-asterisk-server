import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { field, check, dataTable, openDialog, select, stateBadge, loadDestinationData, describeDestination, destinationPicker } from './common.js';

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const OVERRIDE = { auto: 'Follow schedule', open: 'Forced open', closed: 'Forced closed' };

const zones = () => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; }
};

export function callflowView() {
  const dialogHost = h('div');
  const rgBox = h('section', { class: 'panel' });
  const tcBox = h('section', { class: 'panel' });
  let data = { extensions: [], ringGroups: [], timeConditions: [] };

  async function load() {
    try {
      data = await loadDestinationData();
      renderRing();
      renderTime();
    } catch (err) {
      mount(rgBox, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  // ----------------------------------------------------------------- ring groups
  function renderRing() {
    mount(
      rgBox,
      h('div', { class: 'section-head' }, h('h2', null, 'Ring groups'),
        h('button', { class: 'btn primary', id: 'add-ringgroup', onclick: () => editRing(null) }, 'Add ring group')),
      h('p', { class: 'muted small' }, 'Ring several extensions for one number: all at once, or one after another. People on do-not-disturb are skipped. A ring group can be dialled internally and used as the destination of any inbound route.'),
      dataTable(
        ['Number', 'Name', 'Rings', 'Members', 'If nobody answers', ''],
        data.ringGroups.map((g) => [
          h('strong', null, g.number), g.name,
          g.strategy === 'ringall' ? `all at once, ${g.ring_secs}s` : `in order, ${g.ring_secs}s each`,
          g.members.join(g.strategy === 'sequential' ? ' → ' : ', '),
          describeDestination(g.fail_dest, data),
          h('div', { class: 'row-actions' },
            g.enabled ? null : stateBadge('offline', 'Disabled'),
            h('button', { class: 'btn small', onclick: () => editRing(g) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => remove('ring-groups', g, `ring group ${g.number}`) }, 'Delete')),
        ]),
        { empty: 'No ring groups yet.' },
      ),
    );
  }

  function editRing(g) {
    const creating = !g;
    openDialog(dialogHost, {
      title: creating ? 'Add ring group' : `Edit ring group ${g.number}`,
      wide: true,
      build: ({ close, showError }) => {
        const f = {
          number: h('input', { required: true, pattern: '[0-9]{3,6}', placeholder: 'e.g. 800', value: g?.number || '', disabled: !creating }),
          name: h('input', { required: true, maxlength: 40, placeholder: 'e.g. Sales', value: g?.name || '' }),
          strategy: select([{ value: 'ringall', label: 'Ring everyone at once' }, { value: 'sequential', label: 'Ring one after another, in the order below' }], g?.strategy || 'ringall'),
          secs: h('input', { type: 'number', min: 5, max: 120, value: g?.ring_secs || 20 }),
          enabled: h('input', { type: 'checkbox', checked: g ? g.enabled : true }),
        };
        const fail = destinationPicker(data, { value: g?.fail_dest, allowNone: true, noneLabel: 'Hang up', exclude: g ? `ringgroup:${g.number}` : null });
        let members = [...(g?.members || [])];
        const list = h('div', { class: 'stack' });
        const add = h('select');
        const draw = () => {
          mount(list, members.length ? members.map((n, i) => {
            const x = data.extensions.find((e) => e.number === n);
            return h('div', { class: 'order-row' }, h('span', null, `${i + 1}. ${n} ${x ? x.display_name : ''}`),
              h('button', { class: 'btn small', type: 'button', disabled: i === 0, onclick: () => { [members[i - 1], members[i]] = [members[i], members[i - 1]]; draw(); } }, '↑'),
              h('button', { class: 'btn small', type: 'button', disabled: i === members.length - 1, onclick: () => { [members[i + 1], members[i]] = [members[i], members[i + 1]]; draw(); } }, '↓'),
              h('button', { class: 'btn small danger', type: 'button', onclick: () => { members = members.filter((m) => m !== n); draw(); } }, 'Remove'));
          }) : h('p', { class: 'muted small' }, 'No members yet.'));
          mount(add, h('option', { value: '' }, 'Add an extension...'), data.extensions.filter((e) => !members.includes(e.number)).map((e) => h('option', { value: e.number }, `${e.number} ${e.display_name}`)));
        };
        add.addEventListener('change', () => { if (add.value) { members.push(add.value); draw(); } });
        draw();
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = { name: f.name.value.trim(), strategy: f.strategy.value, ring_secs: Number(f.secs.value) || 20, members, fail_dest: fail.get(), enabled: f.enabled.checked };
            try {
              if (creating) await api('POST', '/pbx/ring-groups', { number: f.number.value.trim(), ...body });
              else await api('PATCH', `/pbx/ring-groups/${g.id}`, body);
              store.toast('Ring group saved', 'info');
              close();
              await load();
            } catch (err) { showError(err); }
          },
        },
        h('div', { class: 'form-grid' }, field('Number', f.number, creating ? 'Dial this to reach the group.' : null), field('Name', f.name)),
        field('How it rings', f.strategy),
        field('Ring time (seconds)', f.secs, 'All at once: how long in total. In order: how long each member rings.'),
        h('div', null, h('strong', null, 'Members'), list, add),
        field('If nobody answers', fail.el),
        check(f.enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  // ------------------------------------------------------------- time conditions
  function renderTime() {
    mount(
      tcBox,
      h('div', { class: 'section-head' }, h('h2', null, 'Business hours (time conditions)'),
        h('button', { class: 'btn primary', id: 'add-timecondition', onclick: () => editTime(null) }, 'Add schedule')),
      h('p', { class: 'muted small' }, 'Send calls one way during open hours and another way otherwise (for example: reception during the day, an answering message at night). Use a schedule as the destination of an inbound route. The buttons let you override the schedule instantly, for example on a snow day.'),
      dataTable(
        ['Name', 'Open hours', 'Open →', 'Closed →', 'Right now', ''],
        data.timeConditions.map((t) => [
          h('div', null, h('strong', null, t.name), h('div', { class: 'muted small' }, t.timezone)),
          t.rules.length ? t.rules.map((r) => h('div', null, `${r.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(' ')} ${r.from}–${r.to}`)) : 'never open',
          describeDestination(t.match_dest, data), describeDestination(t.nomatch_dest, data),
          h('div', { class: 'seg' }, ['auto', 'open', 'closed'].map((m) =>
            h('button', { class: `btn small${t.override === m ? ' primary' : ''}`, 'data-override': m, title: OVERRIDE[m], onclick: () => setOverride(t, m) }, { auto: 'Auto', open: 'Open', closed: 'Closed' }[m]))),
          h('div', { class: 'row-actions' },
            t.enabled ? null : stateBadge('offline', 'Disabled'),
            h('button', { class: 'btn small', onclick: () => editTime(t) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => remove('time-conditions', { id: t.id, name: t.name }, `schedule "${t.name}"`) }, 'Delete')),
        ]),
        { empty: 'No schedules yet.' },
      ),
    );
  }

  async function setOverride(t, mode) {
    if (t.override === mode) return;
    try {
      await api('PATCH', `/pbx/time-conditions/${t.id}`, { override: mode });
      store.toast(`${t.name}: ${OVERRIDE[mode].toLowerCase()}`, 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  function editTime(t) {
    const creating = !t;
    openDialog(dialogHost, {
      title: creating ? 'Add schedule' : `Edit schedule "${t.name}"`,
      wide: true,
      build: ({ close, showError }) => {
        const tz = h('input', { list: 'tz-list', required: true, value: t?.timezone || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') });
        const tzList = h('datalist', { id: 'tz-list' }, zones().map((z) => h('option', { value: z })));
        const name = h('input', { required: true, maxlength: 60, placeholder: 'e.g. Office hours', value: t?.name || '' });
        const enabled = h('input', { type: 'checkbox', checked: t ? t.enabled : true });
        const match = destinationPicker(data, { value: t?.match_dest || { type: 'extension', value: data.extensions[0]?.number }, exclude: t ? `timecondition:${t.id}` : null });
        const nomatch = destinationPicker(data, { value: t?.nomatch_dest || { type: 'hangup', value: 'busy' }, exclude: t ? `timecondition:${t.id}` : null });

        let rules = (t?.rules || [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' }]).map((r) => ({ ...r, days: [...r.days] }));
        const rulesBox = h('div', { class: 'stack' });
        const drawRules = () => mount(rulesBox,
          rules.map((r, i) => h('div', { class: 'rule' },
            h('div', { class: 'inline-checks' }, DAYS.map(([d, label]) =>
              h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.days.includes(d), onchange: (e) => { r.days = e.target.checked ? [...r.days, d] : r.days.filter((x) => x !== d); } }), label))),
            h('div', { class: 'rule-times' },
              h('input', { type: 'time', value: r.from, required: true, onchange: (e) => { r.from = e.target.value; } }), ' to ',
              h('input', { type: 'time', value: r.to, required: true, onchange: (e) => { r.to = e.target.value; } }),
              h('button', { class: 'btn small danger', type: 'button', onclick: () => { rules.splice(i, 1); drawRules(); } }, 'Remove')))),
          h('button', { class: 'btn small', type: 'button', onclick: () => { rules.push({ days: ['mon'], from: '09:00', to: '17:00' }); drawRules(); } }, 'Add open period'));
        drawRules();

        let holidays = (t?.holidays || []).map((x) => ({ ...x }));
        const holBox = h('div', { class: 'stack' });
        const drawHol = () => mount(holBox,
          holidays.map((x, i) => h('div', { class: 'rule-times' },
            select(MONTHS.map((m, k) => ({ value: String(k + 1), label: m })), String(x.month)),
            h('input', { type: 'number', min: 1, max: 31, value: x.day, onchange: (e) => { x.day = Number(e.target.value); } }),
            h('input', { placeholder: 'name (optional)', value: x.name || '', onchange: (e) => { x.name = e.target.value; } }),
            h('button', { class: 'btn small danger', type: 'button', onclick: () => { holidays.splice(i, 1); drawHol(); } }, 'Remove'))),
          h('button', { class: 'btn small', type: 'button', onclick: () => { holidays.push({ month: 12, day: 25, name: '' }); drawHol(); } }, 'Add closed day'));
        drawHol();
        // The month selects need their change handlers after (re)drawing.
        holBox.addEventListener('change', (e) => {
          const sel = e.target.closest('select');
          if (!sel) return;
          const row = [...holBox.querySelectorAll('.rule-times')].indexOf(sel.parentElement);
          if (row >= 0 && holidays[row]) holidays[row].month = Number(sel.value);
        });

        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = {
              name: name.value.trim(), timezone: tz.value.trim(), enabled: enabled.checked,
              rules: rules.map((r) => ({ days: r.days, from: r.from, to: r.to })),
              holidays: holidays.map((x) => ({ month: Number(x.month), day: Number(x.day), name: String(x.name || '').trim() })),
              match_dest: match.get(), nomatch_dest: nomatch.get(),
            };
            try {
              if (creating) await api('POST', '/pbx/time-conditions', body);
              else await api('PATCH', `/pbx/time-conditions/${t.id}`, body);
              store.toast('Schedule saved', 'info');
              close();
              await load();
            } catch (err) { showError(err); }
          },
        },
        h('div', { class: 'form-grid' }, field('Name', name), field('Time zone', tz, 'e.g. America/New_York, Europe/Berlin, Asia/Manila'), tzList),
        h('div', null, h('strong', null, 'Open periods'), rulesBox),
        h('div', null, h('strong', null, 'Closed all day (holidays)'), holBox),
        field('During open periods, send calls to', match.el),
        field('Otherwise (closed), send calls to', nomatch.el),
        check(enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  async function remove(kind, item, text) {
    if (!window.confirm(`Delete ${text}?`)) return;
    try {
      await api('DELETE', `/pbx/${kind}/${item.id}`);
      store.toast('Deleted', 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  load();
  return { el: h('div', { class: 'stack' }, h('h1', null, 'Call flow'), rgBox, tcBox, dialogHost), destroy() {} };
}
