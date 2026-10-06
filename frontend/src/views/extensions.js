import { h, mount } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';
import { field, check, dataTable, openDialog, nullIfEmpty, copyText, stateBadge } from './common.js';

const STATE_CLASS = { Online: 'online', Offline: 'offline', 'In-Call': 'incall', Paging: 'paging', Unknown: 'unknown' };

export function extensionsView() {
  const dialogHost = h('div');
  const extBox = h('section', { class: 'panel' });
  const groupBox = h('section', { class: 'panel' });
  let extensions = [];
  let groups = [];
  let sipDomain = '';

  const unsubscribe = store.subscribe(() => { if (extensions.length) renderExtensions(); });

  async function load() {
    try {
      const [e, g] = await Promise.all([api('GET', '/pbx/extensions'), api('GET', '/pbx/paging-groups')]);
      extensions = e.extensions;
      sipDomain = e.sipDomain;
      groups = g.groups;
      renderExtensions();
      renderGroups();
    } catch (err) {
      mount(extBox, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  // ---------------------------------------------------------------- extensions
  function liveState(number) {
    const s = store.state.extensions.find((x) => x.extension === number);
    return s ? s.state : null;
  }

  function renderExtensions() {
    mount(
      extBox,
      h('div', { class: 'section-head' },
        h('h2', null, 'Extensions'),
        h('button', { class: 'btn primary', id: 'add-extension', onclick: () => editExtension(null) }, 'Add extension')),
      h('p', { class: 'muted small' }, 'Each extension has a browser softphone login and a separate physical-phone login. Changes apply to the phone system immediately; nobody is disconnected.'),
      dataTable(
        ['Number', 'Name', 'State', 'Clients', 'Outbound calls', 'User', ''],
        extensions.map((x) => {
          const st = x.enabled ? liveState(x.number) : null;
          return [
            h('strong', null, x.number),
            x.display_name,
            x.enabled ? (st ? stateBadge(STATE_CLASS[st] || 'unknown', st) : '—') : stateBadge('offline', 'Disabled'),
            [x.webrtc_enabled ? 'browser' : null, x.phone_enabled ? 'phone' : null].filter(Boolean).join(' + ') || 'none',
            x.allow_outbound ? (x.outbound_cid ? `allowed (CID ${x.outbound_cid})` : 'allowed') : 'internal only',
            x.user || '—',
            h('div', { class: 'row-actions' },
              h('button', { class: 'btn small', onclick: () => editExtension(x) }, 'Edit'),
              h('button', { class: 'btn small', onclick: () => showCredentials(x) }, 'Credentials'),
              h('button', { class: 'btn small danger', onclick: () => removeExtension(x) }, 'Delete')),
          ];
        }),
        { empty: 'No extensions yet.' },
      ),
    );
  }

  function editExtension(x) {
    const creating = !x;
    openDialog(dialogHost, {
      title: creating ? 'Add extension' : `Edit extension ${x.number}`,
      build: ({ close, showError }) => {
        const f = {
          number: h('input', { required: true, inputmode: 'numeric', pattern: '[0-9]{3,6}', placeholder: 'e.g. 1003', value: x?.number || '', disabled: !creating }),
          name: h('input', { required: true, maxlength: 40, placeholder: 'e.g. Reception', value: x?.display_name || '' }),
          cid: h('input', { placeholder: 'e.g. 15551234567 (optional)', value: x?.outbound_cid || '' }),
          notes: h('input', { maxlength: 500, value: x?.notes || '' }),
          webrtc: h('input', { type: 'checkbox', checked: x ? x.webrtc_enabled : true }),
          phone: h('input', { type: 'checkbox', checked: x ? x.phone_enabled : true }),
          outbound: h('input', { type: 'checkbox', checked: x ? x.allow_outbound : false }),
          enabled: h('input', { type: 'checkbox', checked: x ? x.enabled : true }),
        };
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = {
              display_name: f.name.value.trim(),
              webrtc_enabled: f.webrtc.checked,
              phone_enabled: f.phone.checked,
              allow_outbound: f.outbound.checked,
              outbound_cid: nullIfEmpty(f.cid.value),
              enabled: f.enabled.checked,
              notes: nullIfEmpty(f.notes.value),
            };
            try {
              if (creating) {
                const res = await api('POST', '/pbx/extensions', { number: f.number.value.trim(), ...body });
                store.toast(`Extension ${res.extension.number} created`, 'info');
                close();
                await load();
                showCredentials(res.extension);
              } else {
                await api('PATCH', `/pbx/extensions/${x.id}`, body);
                store.toast(`Extension ${x.number} updated`, 'info');
                close();
                await load();
              }
            } catch (err) { showError(err); }
          },
        },
        field('Number', f.number, creating ? '3 to 6 digits. Cannot be changed later.' : null),
        field('Display name', f.name, 'Shown on the dashboard and as caller name.'),
        check(f.webrtc, 'Browser softphone', '(WebRTC, used by the dashboard)'),
        check(f.phone, 'Physical phone', '(SIP over UDP)'),
        check(f.outbound, 'May place outbound calls', '(through trunks; off = internal calls only)'),
        field('Outbound caller ID', f.cid, 'Number shown to the called party. Leave empty to use the route or trunk default.'),
        field('Notes', f.notes),
        check(f.enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, creating ? 'Create extension' : 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  async function removeExtension(x) {
    if (!window.confirm(`Delete extension ${x.number} (${x.display_name})? Its user is unassigned and its phones stop working.`)) return;
    try {
      await api('DELETE', `/pbx/extensions/${x.id}`);
      store.toast(`Extension ${x.number} deleted`, 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  async function showCredentials(x) {
    let creds;
    try {
      creds = await api('GET', `/pbx/extensions/${x.id}/credentials`);
    } catch (err) { store.toast(describeError(err)); return; }
    openDialog(dialogHost, {
      title: `SIP credentials for ${x.number}`,
      wide: true,
      build: ({ close, showError }) => {
        const row = (label, value) => h('div', { class: 'kv' },
          h('span', { class: 'muted' }, label), h('code', null, value),
          h('button', { class: 'btn small', type: 'button', onclick: async (e) => { e.target.textContent = (await copyText(value)) ? 'Copied' : 'Select and copy'; } }, 'Copy'));
        const body = h('div', { class: 'stack' });
        const render = (c) => mount(
          body,
          h('p', { class: 'muted small' }, 'Treat these like passwords. Viewing them is recorded in the audit log.'),
          h('h3', null, 'Physical phone / SIP client'),
          row('Server', c.sipDomain), row('Username', c.phone.username), row('Password', c.phone.password),
          h('p', { class: 'muted small' }, 'Port 5060, UDP. Transport must be UDP; audio codecs ulaw / alaw.'),
          h('h3', null, 'Browser softphone'),
          row('Username', c.browser.username), row('Password', c.browser.password),
          h('p', { class: 'muted small' }, 'The dashboard uses these automatically for the user assigned to this extension; you never type them in.'),
        );
        render(creds);
        const regen = (which, label) => h('button', {
          class: 'btn small danger', type: 'button',
          onclick: async () => {
            if (!window.confirm(`Generate a new ${label} password? The old one stops working immediately.`)) return;
            try { render(await api('POST', `/pbx/extensions/${x.id}/regenerate-secret`, { which })); store.toast('New password generated', 'info'); } catch (err) { showError(err); }
          },
        }, `New ${label} password`);
        return h('div', { class: 'stack' }, body,
          h('div', { class: 'actions' }, regen('phone', 'phone'), regen('browser', 'browser'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')));
      },
    });
  }

  // -------------------------------------------------------------- paging groups
  function renderGroups() {
    mount(
      groupBox,
      h('div', { class: 'section-head' },
        h('h2', null, 'Paging groups'),
        h('button', { class: 'btn primary', id: 'add-group', onclick: () => editGroup(null) }, 'Add paging group')),
      h('p', { class: 'muted small' }, 'Dial the group number (or use the Page buttons on the dashboard) to broadcast one-way live audio to every member.'),
      dataTable(
        ['Number', 'Name', 'Members', 'Status', ''],
        groups.map((g) => [
          h('strong', null, g.number), g.name, g.members.join(', ') || '—',
          g.enabled ? stateBadge('online', 'Enabled') : stateBadge('offline', 'Disabled'),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn small', onclick: () => editGroup(g) }, 'Edit'),
            h('button', { class: 'btn small danger', onclick: () => removeGroup(g) }, 'Delete')),
        ]),
        { empty: 'No paging groups yet.' },
      ),
    );
  }

  function editGroup(g) {
    const creating = !g;
    openDialog(dialogHost, {
      title: creating ? 'Add paging group' : `Edit paging group ${g.number}`,
      build: ({ close, showError }) => {
        const number = h('input', { required: true, pattern: '[0-9]{3,6}', value: g?.number || '', disabled: !creating, placeholder: 'e.g. 703' });
        const name = h('input', { required: true, maxlength: 40, value: g?.name || '', placeholder: 'e.g. Page Reception' });
        const enabled = h('input', { type: 'checkbox', checked: g ? g.enabled : true });
        const boxes = extensions.map((x) => ({ x, el: h('input', { type: 'checkbox', checked: g ? g.members.includes(x.number) : false }) }));
        return h('form', {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            const members = boxes.filter((b) => b.el.checked).map((b) => b.x.number);
            try {
              if (creating) await api('POST', '/pbx/paging-groups', { number: number.value.trim(), name: name.value.trim(), enabled: enabled.checked, members });
              else await api('PATCH', `/pbx/paging-groups/${g.id}`, { name: name.value.trim(), enabled: enabled.checked, members });
              store.toast('Paging group saved', 'info');
              close();
              await load();
            } catch (err) { showError(err); }
          },
        },
        field('Number', number, creating ? 'The number dialled to page this group.' : null),
        field('Name', name),
        h('fieldset', { class: 'members' }, h('legend', null, 'Members'),
          boxes.length ? boxes.map((b) => check(b.el, `${b.x.number} ${b.x.display_name}`)) : h('p', { class: 'muted' }, 'Create extensions first.')),
        check(enabled, 'Enabled'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
      },
    });
  }

  async function removeGroup(g) {
    if (!window.confirm(`Delete paging group ${g.number} (${g.name})?`)) return;
    try {
      await api('DELETE', `/pbx/paging-groups/${g.id}`);
      store.toast(`Paging group ${g.number} deleted`, 'info');
      await load();
    } catch (err) { store.toast(describeError(err)); }
  }

  load();
  return {
    el: h('div', { class: 'stack' }, h('h1', null, 'Extensions'), extBox, groupBox, dialogHost),
    destroy() { unsubscribe(); },
  };
}
