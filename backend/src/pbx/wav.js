'use strict';
const { badRequest } = require('../errors');

// Converts an uploaded WAV into what Asterisk plays natively: 8 kHz, mono, 16-bit PCM. Pure JavaScript, no external
// tools. MP3 and other formats are converted to WAV by the browser before upload (see the Prompts UI).

const OUT_RATE = 8000;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_SECONDS = 300;
const MIN_SECONDS = 0.2;

function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw badRequest('That is not a WAV file (too small)', 'bad_audio');
  if (buf.length > MAX_INPUT_BYTES) throw badRequest('The audio file is too large (12 MB maximum)', 'bad_audio');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw badRequest('That is not a WAV file. Use the Upload button, which converts MP3 and other formats first.', 'bad_audio');
  }
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (start + size > buf.length) size = buf.length - start; // tolerate a truncated final chunk
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      };
      // WAVE_FORMAT_EXTENSIBLE: the real format is in the sub-format GUID.
      if (fmt.format === 0xfffe && size >= 26) fmt.format = buf.readUInt16LE(start + 24);
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
    }
    pos = start + size + (size % 2);
  }
  if (!fmt || !data) throw badRequest('The WAV file is damaged (no audio found)', 'bad_audio');
  const ok = (fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && fmt.bits === 32);
  if (!ok) throw badRequest('Unsupported WAV encoding. Use uncompressed PCM, or upload the file with the Upload button.', 'bad_audio');
  if (fmt.channels < 1 || fmt.channels > 8) throw badRequest('Unsupported number of channels', 'bad_audio');
  if (fmt.sampleRate < 4000 || fmt.sampleRate > 192000) throw badRequest('Unsupported sample rate', 'bad_audio');
  return { ...fmt, data };
}

/** Decode to mono floats in [-1, 1]. */
function toMono({ format, channels, bits, data }) {
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const out = new Float32Array(frames);
  const read = (off) => {
    if (format === 3) return data.readFloatLE(off);
    if (bits === 8) return (data[off] - 128) / 128;
    if (bits === 16) return data.readInt16LE(off) / 32768;
    if (bits === 24) return data.readIntLE(off, 3) / 8388608;
    return data.readInt32LE(off) / 2147483648;
  };
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += read((i * channels + c) * bytes);
    out[i] = sum / channels;
  }
  return out;
}

/** Resample to 8 kHz: average over the source window when decimating (a crude but effective low-pass), interpolate otherwise. */
function resample(samples, rate) {
  if (rate === OUT_RATE) return samples;
  const ratio = rate / OUT_RATE;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (ratio > 1) {
      const a = Math.floor(i * ratio);
      const b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let k = a; k < b; k += 1) sum += samples[k];
      out[i] = sum / (b - a);
    } else {
      const pos = i * ratio;
      const k = Math.floor(pos);
      const frac = pos - k;
      out[i] = samples[k] * (1 - frac) + (samples[Math.min(k + 1, samples.length - 1)] * frac);
    }
  }
  return out;
}

function encodeWav(samples) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(OUT_RATE, 24);
  out.writeUInt32LE(OUT_RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36);
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return out;
}

/** WAV bytes in, { wav, durationMs } out (8 kHz mono 16-bit). Throws a 400 for anything unusable. */
function toTelephonyWav(buf) {
  const wav = parseWav(buf);
  const mono = resample(toMono(wav), wav.sampleRate);
  const seconds = mono.length / OUT_RATE;
  if (seconds < MIN_SECONDS) throw badRequest('The recording is too short', 'bad_audio');
  if (seconds > MAX_SECONDS) throw badRequest(`The recording is too long (${MAX_SECONDS} seconds maximum)`, 'bad_audio');
  return { wav: encodeWav(mono), durationMs: Math.round(seconds * 1000) };
}

module.exports = { toTelephonyWav, parseWav, MAX_INPUT_BYTES, OUT_RATE };
