'use strict';
const fsp = require('node:fs/promises');

/**
 * Size and length of a WAV file Asterisk wrote (voicemail, call recording). Tolerant on purpose: a file that is still
 * being written, or whose last chunk was cut short by a crash, has a data size of 0 or too large in its header, so the
 * length is taken from the real file size. Returns null when the file is missing or is not WAV.
 */
async function wavInfo(file) {
  let stat;
  let head;
  try {
    stat = await fsp.stat(file);
    const fh = await fsp.open(file, 'r');
    try {
      head = Buffer.alloc(Math.min(4096, stat.size));
      await fh.read(head, 0, head.length, 0);
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (head.length < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  let dataStart = 0;
  let pos = 12;
  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4);
    const size = head.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 20 <= head.length) byteRate = head.readUInt32LE(pos + 16);
    if (id === 'data') { dataStart = pos + 8; break; }
    pos += 8 + size + (size % 2);
  }
  if (!byteRate || !dataStart) return null;
  return { bytes: stat.size, durationSecs: Math.max(0, Math.round(((stat.size - dataStart) / byteRate) * 10) / 10) };
}

module.exports = { wavInfo };
