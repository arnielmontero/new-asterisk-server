import { h, mount, fmtTime } from '../dom.js';
import { api, describeError } from '../api.js';
import { store } from '../store.js';

const ROLES = ['admin', 'operator', 'user'];

export function usersView() {
  const table = h('div', { class: 'table-wrap' });
  const dialogHost = h('div');
  const formError = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const f = {
    username: h('input', { name: 'username', required: true, autocomplete: 'off', placeholder: 'e.g. jane.doe' }),
    password: h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'at least 12 characters' }),
    role: h('select', { name: 'role' }, ROLES.map((r) => h('option', { value: r }, r))),
    extension: h('select', { name: 'extension' }, [h('option', { value: '' }, 'none')]),
  };
  f.role.value = 'operator';

  const form = h(
    'form',
    {
      class: 'panel form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        formError.hidden = true;
        try {
          await api('POST', '/users', { username: f.username.value, password: f.password.value, role: f.role.value, extension: f.extension.value || null });
          form.reset();
          f.role.value = 'operator';
          store.toast('User created', 'info');
          await load();
        } catch (err) {
          formError.textContent = describeError(err);
          formError.hidden = false;
        }
      },
    },
    h('h2', null, 'Add user'),
    h('label', null, 'Username', f.username),
    h('label', null, 'Password', f.password),
    h('label', null, 'Role', f.role),
    h('label', null, 'SIP extension', f.extension),
    formError,
    h('button', { class: 'btn primary', type: 'submit' }, 'Create user'),
  );

  let extensionList = [];
  const fillExtensions = (list) => {
    extensionList = list;
    mount(f.extension, h('option', { value: '' }, 'none'),
      list.map((e) => h('option', { value: e.number }, `${e.number} ${e.display_name}${e.user ? ` (in use by ${e.user})` : ''}`)));
  };

  async function load() {
    try {
      const [{ users }, { extensions }] = await Promise.all([api('GET', '/users'), api('GET', '/pbx/extensions')]);
      fillExtensions(extensions);
      render(users);
    } catch (err) {
      mount(table, h('p', { class: 'form-error' }, describeError(err)));
    }
  }

  function render(users) {
    mount(
      table,
      h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Username', 'Role', 'Extension', 'Status', 'Created', ''].map((t) => h('th', null, t)))),
        h('tbody', null, users.map((u) =>
          h('tr', { 'data-username': u.username },
            h('td', null, u.username),
            h('td', null, h('span', { class: `role ${u.role}` }, u.role)),
            h('td', null, u.extension || '—'),
            h('td', null, u.is_active ? 'Active' : 'Disabled'),
            h('td', null, fmtTime(u.created_at)),
            h('td', { class: 'row-actions' },
              h('button', { class: 'btn small', onclick: () => edit(u) }, 'Edit'),
              h('button', { class: 'btn small danger', onclick: () => remove(u) }, 'Delete')))))),
    );
  }

  async function remove(u) {
    if (!window.confirm(`Delete user "${u.username}"? Their audit history is kept.`)) return;
    try {
      await api('DELETE', `/users/${u.id}`);
      store.toast(`Deleted ${u.username}`, 'info');
      await load();
    } catch (err) {
      store.toast(describeError(err));
    }
  }

  function edit(u) {
    const role = h('select', null, ROLES.map((r) => h('option', { value: r }, r)));
    role.value = u.role;
    const ext = h('select', null, [h('option', { value: '' }, 'none'), extensionList.map((e) => h('option', { value: e.number }, `${e.number} ${e.display_name}${e.user && e.user !== u.username ? ` (in use by ${e.user})` : ''}`))]);
    ext.value = u.extension || '';
    const active = h('input', { type: 'checkbox', checked: u.is_active });
    const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'leave blank to keep' });
    const err = h('p', { class: 'form-error', hidden: true });
    const close = () => mount(dialogHost);
    mount(
      dialogHost,
      h('div', { class: 'overlay', onclick: (e) => { if (e.target.classList.contains('overlay')) close(); } },
        h('form', {
          class: 'dialog',
          onsubmit: async (e) => {
            e.preventDefault();
            const patch = {};
            if (role.value !== u.role) patch.role = role.value;
            if ((ext.value || null) !== u.extension) patch.extension = ext.value || null;
            if (active.checked !== u.is_active) patch.is_active = active.checked;
            if (pw.value) patch.password = pw.value;
            if (!Object.keys(patch).length) { close(); return; }
            try {
              await api('PATCH', `/users/${u.id}`, patch);
              store.toast(`Updated ${u.username}`, 'info');
              close();
              await load();
            } catch (ex) {
              err.textContent = describeError(ex);
              err.hidden = false;
            }
          },
        },
        h('h2', null, `Edit ${u.username}`),
        h('label', null, 'Role', role),
        h('label', null, 'SIP extension', ext),
        h('label', { class: 'check' }, active, ' Account active'),
        h('label', null, 'Reset password', pw),
        err,
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')))),
    );
  }

  load();
  return { el: h('div', { class: 'stack' }, h('h1', null, 'Users'), form, h('section', { class: 'panel' }, table), dialogHost), destroy() {} };
}
