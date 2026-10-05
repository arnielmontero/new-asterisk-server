import { h } from '../dom.js';
import { primeAudio } from '../ringtone.js';

/**
 * First-use gate: browsers will not let a page use the microphone or play audio
 * until the user grants permission and interacts with the page. This one click
 * requests the microphone and unlocks audio playback; afterwards pages and calls
 * work without further prompts. It cannot be skipped or automated by the app.
 */
export function setupView({ user, onReady }) {
  const status = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const button = h('button', { type: 'button', class: 'btn primary big' }, 'Enable microphone and audio');

  const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  if (!secure) {
    status.textContent = 'This page is not a secure (HTTPS) origin or the browser has no microphone support. Open the site with https:// and install the LAN CA certificate (see the deployment guide).';
    status.hidden = false;
    button.disabled = true;
  }

  button.addEventListener('click', async () => {
    status.hidden = true;
    button.disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // permission is remembered; release the device
      await primeAudio();
      const audio = document.getElementById('remote-audio');
      audio.muted = false;
      try { await audio.play(); } catch { /* nothing to play yet; the gesture still unlocks playback */ }
      onReady();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      status.textContent = denied
        ? 'Microphone access was denied. Click the lock/camera icon in the address bar, allow the microphone for this site, then try again.'
        : err && err.name === 'NotFoundError'
          ? 'No microphone was found. Connect a headset or microphone, then try again.'
          : `Could not enable audio: ${err?.message || 'unknown error'}`;
      status.hidden = false;
      button.disabled = false;
    }
  });

  return {
    el: h(
      'div',
      { class: 'login-wrap' },
      h(
        'div',
        { class: 'login-card' },
        h('h1', null, `Welcome, ${user.username}`),
        h('p', null, `Your phone is extension ${user.extension}. To make and receive calls and pages, the browser needs permission to use your microphone and speakers.`),
        h('p', { class: 'muted' }, 'This is a one-time step each time you open the dashboard. Pages play automatically after you allow it.'),
        status,
        button,
      ),
    ),
    destroy() {},
  };
}
