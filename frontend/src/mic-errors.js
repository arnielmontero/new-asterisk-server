/** Human wording for every way getUserMedia can fail (exported for the unit test). */
export function microphoneErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Click the lock/camera icon in the address bar, allow the microphone for this site, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Connect a headset or microphone, then try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The microphone is in use by another application or cannot be opened. Close the other application, then try again.';
  }
  if (name === 'NotSupportedError') {
    return 'The browser refused microphone access (blocked by a browser or site policy, or the page is not a trusted HTTPS origin). Check the site permissions and that the LAN CA certificate is installed, then try again.';
  }
  return `Could not enable audio: ${(err && err.message) || 'unknown error'}`;
}
