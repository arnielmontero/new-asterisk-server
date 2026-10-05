import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microphoneErrorMessage } from '../src/mic-errors.js';

const msg = (name, message) => microphoneErrorMessage({ name, message });

test('permission denied tells the user how to allow the microphone', () => {
  assert.match(msg('NotAllowedError'), /denied.*allow the microphone/i);
  assert.match(msg('SecurityError'), /denied/i);
});

test('missing, busy and refused microphones each get their own guidance', () => {
  assert.match(msg('NotFoundError'), /No microphone was found/);
  assert.match(msg('OverconstrainedError'), /No microphone was found/);
  assert.match(msg('NotReadableError'), /in use by another application/);
  assert.match(msg('NotSupportedError'), /refused microphone access.*LAN CA/);
});

test('unknown failures still show the underlying message, never "undefined"', () => {
  assert.equal(msg('WeirdError', 'boom'), 'Could not enable audio: boom');
  assert.equal(microphoneErrorMessage(undefined), 'Could not enable audio: unknown error');
});
