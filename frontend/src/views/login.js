import { h } from '../dom.js';
import { api, describeError } from '../api.js';

export function loginView({ onLoggedIn }) {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const user = h('input', { id: 'username', name: 'username', type: 'text', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const button = h('button', { type: 'submit', class: 'btn primary' }, 'Sign in');

  const form = h(
    'form',
    {
      class: 'login-card',
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        button.disabled = true;
        try {
          const { user: me } = await api('POST', '/auth/login', { username: user.value, password: pass.value });
          pass.value = '';
          onLoggedIn(me);
        } catch (err) {
          error.textContent =
            err.status === 429 ? 'Too many attempts. Wait a few minutes and try again.'
            : err.status === 401 ? 'Invalid username or password.'
            : describeError(err);
          error.hidden = false;
          pass.select();
        } finally {
          button.disabled = false;
        }
      },
    },
    h('h1', null, 'LAN Communications'),
    h('p', { class: 'muted' }, 'Sign in to the intercom and phone dashboard.'),
    h('label', { for: 'username' }, 'Username'),
    user,
    h('label', { for: 'password' }, 'Password'),
    pass,
    error,
    button,
  );
  return { el: h('div', { class: 'login-wrap' }, form), destroy() {} };
}
