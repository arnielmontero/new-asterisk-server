// A simple synthesized two-tone ring for ordinary incoming calls (no audio files needed).
let ctx = null;
let timer = null;
let nodes = [];

export function primeAudio() {
  // Must be called from a user gesture (the "Enable audio" button).
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return Promise.resolve();
  ctx = ctx || new AC();
  return ctx.resume().catch(() => {});
}

function burst() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  for (const [freq, offset] of [[440, 0], [480, 0]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.05);
    gain.gain.setValueAtTime(0.12, now + offset + 0.9);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 1.0);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 1.05);
    nodes.push(osc);
  }
}

export function startRingtone() {
  stopRingtone();
  burst();
  timer = setInterval(burst, 4000);
}

export function stopRingtone() {
  clearInterval(timer);
  timer = null;
  for (const n of nodes) { try { n.stop(); } catch { /* already stopped */ } }
  nodes = [];
}
