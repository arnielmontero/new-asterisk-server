// Browser-side audio preparation for prompts: any audio the browser can decode (MP3, M4A, OGG, WAV, a microphone
// recording) becomes an 8 kHz mono 16-bit WAV, which is what the phone system plays. The server accepts any PCM WAV
// and converts it again, so this step only widens what can be uploaded.

export function encodeWav(samples, rate = 8000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

/** Decode any browser-supported audio and render it at 8 kHz mono. */
export async function toWav8k(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error('This browser cannot read that audio file. Try a WAV or MP3 file, or record with the microphone.');
  } finally {
    ctx.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * 8000));
  const offline = new OfflineAudioContext(1, frames, 8000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0));
}

/** Records the microphone. start() asks for permission; stop() resolves to the recorded audio as an ArrayBuffer. */
export class MicRecorder {
  constructor() { this.recorder = null; this.stream = null; this.chunks = []; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start();
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.recorder) { reject(new Error('Not recording')); return; }
      this.recorder.onstop = async () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        try { resolve(await new Blob(this.chunks, { type: this.recorder.mimeType }).arrayBuffer()); } catch (err) { reject(err); }
      };
      this.recorder.stop();
    });
  }

  cancel() {
    try { this.recorder?.stop(); } catch { /* already stopped */ }
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}

/** Upload an 8 kHz WAV (ArrayBuffer) as a prompt. */
export async function uploadPrompt(name, wav) {
  const res = await fetch(`/api/pbx/prompts?name=${encodeURIComponent(name)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' }, body: wav,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Upload failed (${res.status})`);
    e.details = data?.error?.details;
    throw e;
  }
  return data.prompt;
}
