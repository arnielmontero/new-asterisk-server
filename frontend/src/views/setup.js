import { h } from '../dom.js';
import { primeAudio } from '../ringtone.js';
import { microphoneErrorMessage } from '../mic-errors.js';

/**
 * First-use gate: browsers will not let a page use the microphone or play audio
 * until the user grants permission and interacts with the page. This one click
 * requests the microphone and unlocks audio playback; afterwards pages and calls
 * work without further prompts. It cannot be skipped or automated by the app.
 */
// Audio unlocking is best-effort: AudioContext.resume() / audio.play() can stay pending on
// devices with no audio output or no media loaded yet. Never let that block the flow.
const settle = (promise, ms) => Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);

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
      await settle(primeAudio(), 1500);
      const audio = document.getElementById('remote-audio');
      audio.muted = false;
      await settle(audio.play(), 500); // nothing to play yet; the gesture itself unlocks later playback
      onReady();
    } catch (err) {
      status.textContent = microphoneErrorMessage(err);
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
