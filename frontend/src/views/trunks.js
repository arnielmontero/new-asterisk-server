import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { field, check, dataTable, openDialog, nullIfEmpty, splitList, select, stateBadge } from './common.js';

const KINDS = [
  { value: 'provider', label: 'SIP provider (ITSP / VoIP carrier)' },
  { value: 'pbx', label: 'Another PBX (site-to-site)' },
  { value: 'gateway', label: 'FXO / GSM gateway' },
];
const AUTH = [
  { value: 'register', label: 'Registration - the provider gave me a username and password' },
  { value: 'ip', label: 'IP address - the other side trusts my IP (no registration)' },
];
const CODECS = ['ulaw', 'alaw', 'g722', 'gsm', 'opus', 'g729'];
const STATE_CLASS = { online: 'online', offline: 'unknown', unknown: 'offline', disabled: 'offline' };
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label.split(' (')[0].split(' - ')[0]]));

export function trunksView() {
  const dialogHost = h('div');
  const box = h('section', { class: 'panel' });
  let trunks = [];
  let extensions = [];
  let live = new Map();

  const unsubscribe = store.subscribe((s) => {
    if (s.trunks) { live = new Map(s.trunks.map((t) => [t.name, t])); if (trunks.length) render(); }
  });

  async function load() {
    try {
      const [t, e] = await Promise.all([api('GET', '/pbx/trunks'), api('GET', '/pbx/extensions')]);
      trunks = t.trunks;
      extensions = e.extensions;
      live = new Map(trunks.filter((x) => x.status).map((x) => [x.name, x.status]));
      render();
    } catch (err) {
      mount(box, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  function statusCell(t) {
    const s = live.get(t.name) || t.status;
    if (!s) return '—';
    return h('span', null, stateBadge(STATE_CLASS[s.state] || 'offline', s.state.toUpperCase()), ' ', h('span', { class: 'muted small' }, s.detail),
      s.activeChannels ? h('span', { class: 'muted small' }, ` · ${s.activeChannels} call${s.activeChannels === 1 ? '' : 's'}`) : null);
  }

  function render() {
    mount(
      box,
      h('div', { class: 'section-head' },
        h('h2', null, 'Trunks'),
        h('button', { class: 'btn primary', id: 'add-trunk', onclick: () => editTrunk(null) }, 'Add trunk')),
      h('p', { class: 'muted small' }, 'A trunk connects this phone system to the outside: a SIP provider that gives you phone numbers, another PBX, or a gateway with analog lines or SIM cards. Trunks are only used once an outbound or inbound route points at them (Routes page).'),
      dataTable(
        ['Name', 'Type', 'Server', 'Login', 'Status', ''],
        trunks.map((t) => [
          h('div', null, h('strong', null, t.display_name), h('div', { class: 'muted small' }, t.name)),
          `${KIND_LABEL[t.kind] || t.kind}${t.enabled ? '' : ' (disabled)'}`,
          `${t.host}:${t.port} ${t.transport.toUpperCase()}`,
          t.auth_mode === 'register' ? `registers as ${t.username}` : 'by IP address',
          statusCell(t),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small', onclick: () => editTrunk(t) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => removeTrunk(t) }, 'Delete')),
        ]),
        { empty: 'No trunks yet. Add one to place or receive outside calls.' },
      ),
    );
  }

  function editTrunk(t) {
    const creating = !t;
    openDialog(dialogHost, {
      title: creating ? 'Add trunk' : `Edit trunk ${t.name}`,
      wide: true,
      build: ({ close, showError }) => {
        const f = {
          name: h('input', { required: true, pattern: '[a-z][a-z0-9_-]{1,23}', placeholder: 'e.g. acme-sip', value: t?.name || '', disabled: !creating }),
          display: h('input', { required: true, maxlength: 40, placeholder: 'e.g. Acme VoIP', value: t?.display_name || '' }),
          kind: select(KINDS, t?.kind || 'provider'),
          mode: select(AUTH, t?.auth_mode || 'register'),
          host: h('input', { required: true, placeholder: 'sip.provider.com or 192.168.1.50', value: t?.host || '' }),
          port: h('input', { type: 'number', min: 1, max: 65535, value: t?.port || 5060 }),
          transport: select([{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }], t?.transport || 'udp'),
          username: h('input', { autocomplete: 'off', value: t?.username || '' }),
          password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: t?.has_password ? 'unchanged - type to replace' : '' }),
          authUser: h('input', { autocomplete: 'off', value: t?.auth_username || '', placeholder: 'only if different from the username' }),
          fromUser: h('input', { value: t?.from_user || '' }),
          fromDomain: h('input', { value: t?.from_domain || '' }),
          expiry: h('input', { type: 'number', min: 60, max: 86400, value: t?.register_expiry || 3600 }),
          matchIps: h('textarea', { rows: 2, placeholder: 'extra addresses to accept calls from, e.g. 203.0.113.10 or 203.0.113.0/24' }, (t?.match_ips || []).join('\n')),
          dtmf: select([{ value: 'rfc4733', label: 'RFC 4733 (default)' }, { value: 'inband', label: 'In-band' }, { value: 'info', label: 'SIP INFO' }, { value: 'auto', label: 'Auto' }], t?.dtmf_mode || 'rfc4733'),
          max: h('input', { type: 'number', min: 0, max: 500, value: t?.max_channels ?? 0 }),
          cidNum: h('input', { placeholder: 'e.g. 15551234567', value: t?.caller_id_num || '' }),
          cidName: h('input', { value: t?.caller_id_name || '' }),
          defType: select([{ value: '', label: 'Reject the call' }, { value: 'extension', label: 'Ring an extension' }, { value: 'echo', label: 'Echo test' }], t?.inbound_default?.type || ''),
          defExt: select(extensions.map((e) => ({ value: e.number, label: `${e.number} ${e.display_name}` })), t?.inbound_default?.value || extensions[0]?.number),
          qualify: h('input', { type: 'checkbox', checked: t ? t.qualify : true }),
          enabled: h('input', { type: 'checkbox', checked: t ? t.enabled : true }),
          notes: h('input', { maxlength: 500, value: t?.notes || '' }),
        };
        const codecBoxes = CODECS.map((c) => ({ c, el: h('input', { type: 'checkbox', checked: (t?.codecs || ['ulaw', 'alaw']).includes(c) }) }));
        const registerOnly = h('div', { class: 'stack' },
          field('Username', f.username), field('Password', f.password), field('Authentication username', f.authUser),
          field('Re-register every (seconds)', f.expiry));
        const ipOnly = h('div', { class: 'stack' }, field('Accept calls from (additional IPs)', f.matchIps, 'The server above is always accepted. One address or range per line.'));
        const advanced = h('details', null, h('summary', null, 'Advanced'),
          h('div', { class: 'form-grid' },
            field('From user', f.fromUser, 'Rarely needed'), field('From domain', f.fromDomain, 'Rarely needed'),
            field('DTMF mode', f.dtmf), field('Max simultaneous calls', f.max, '0 = no limit'),
            field('Caller ID number', f.cidNum, 'Presented on outbound calls when nothing more specific is set'), field('Caller ID name', f.cidName)));
        const syncMode = () => {
          const reg = f.mode.value === 'register';
          registerOnly.hidden = !reg;
          ipOnly.hidden = reg;
        };
        f.mode.addEventListener('change', syncMode);
        const syncDef = () => { f.defExt.hidden = f.defType.value !== 'extension'; };
        f.defType.addEventListener('change', syncDef);
        setTimeout(() => { syncMode(); syncDef(); }, 0);

        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const codecs = codecBoxes.filter((b) => b.el.checked).map((b) => b.c);
            const reg = f.mode.value === 'register';
            const body = {
              display_name: f.display.value.trim(),
              kind: f.kind.value,
              auth_mode: f.mode.value,
              host: f.host.value.trim(),
              port: Number(f.port.value) || 5060,
              transport: f.transport.value,
              username: reg ? nullIfEmpty(f.username.value) : null,
              auth_username: reg ? nullIfEmpty(f.authUser.value) : null,
              register_expiry: Number(f.expiry.value) || 3600,
              from_user: nullIfEmpty(f.fromUser.value),
              from_domain: nullIfEmpty(f.fromDomain.value),
              match_ips: reg ? [] : splitList(f.matchIps.value),
              codecs,
              dtmf_mode: f.dtmf.value,
              max_channels: Number(f.max.value) || 0,
              caller_id_num: nullIfEmpty(f.cidNum.value),
              caller_id_name: nullIfEmpty(f.cidName.value),
              inbound_default: f.defType.value ? { type: f.defType.value, value: f.defType.value === 'extension' ? f.defExt.value : '' } : null,
              qualify: f.qualify.checked,
              enabled: f.enabled.checked,
              notes: nullIfEmpty(f.notes.value),
            };
            if (f.password.value) body.password = f.password.value;
            else if (creating) body.password = null;
            try {
              if (creating) await api('POST', '/pbx/trunks', { name: f.name.value.trim(), ...body });
              else await api('PATCH', `/pbx/trunks/${t.id}`, body);
              store.toast(`Trunk ${creating ? f.name.value.trim() : t.name} saved`, 'info');
              close();
              await load();
            } catch (err) { showError(err); }
          },
        },
        h('div', { class: 'form-grid' },
          field('Name', f.name, creating ? 'Short id used in routes. Cannot be changed later.' : null),
          field('Display name', f.display),
          field('What are you connecting to?', f.kind),
          field('How does it authenticate?', f.mode)),
        h('div', { class: 'form-grid' }, field('Server (host or IP)', f.host), field('Port', f.port), field('Transport', f.transport)),
        registerOnly, ipOnly,
        h('fieldset', { class: 'members' }, h('legend', null, 'Audio codecs (in order of preference: ulaw, alaw, g722 ...)'),
          h('div', { class: 'inline-checks' }, codecBoxes.map((b) => check(b.el, b.c)))),
        field('Calls that match no inbound route', f.defType), f.defExt,
        check(f.qualify, 'Check that the trunk is reachable', '(sends SIP OPTIONS every minute)'),
        advanced,
        field('Notes', f.notes),
        check(f.enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save trunk'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  async function removeTrunk(t) {
    if (!window.confirm(`Delete trunk "${t.display_name}"? Routes that use it must be changed first.`)) return;
    try {
      await api('DELETE', `/pbx/trunks/${t.id}`);
      store.toast(`Trunk ${t.name} deleted`, 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  load();
  return { el: h('div', { class: 'stack' }, h('h1', null, 'Trunks'), box, dialogHost), destroy() { unsubscribe(); } };
}
