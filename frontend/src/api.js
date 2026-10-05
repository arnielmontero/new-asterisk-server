import { store } from './store.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

/**
 * Same-origin JSON API call. The session lives in an HttpOnly cookie, so no
 * token is ever read or stored by this code.
 */
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    store.set({ backendOk: false });
    throw new ApiError(0, 'backend_unavailable', 'Cannot reach the server. Check your network connection; retrying automatically.');
  }
  if (!store.state.backendOk) store.set({ backendOk: true });

  let data = null;
  try {
    data = await res.json();
  } catch { /* empty body */ }

  if (!res.ok) {
    const err = data?.error || {};
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const code = err.code || 'service_unavailable';
      throw new ApiError(res.status, code, err.message || 'The service is temporarily unavailable', err.details);
    }
    throw new ApiError(res.status, err.code || 'error', err.message || `Request failed (${res.status})`, err.details);
  }
  return data;
}

/** Human-readable text for validation errors returned by the API. */
export function describeError(err) {
  if (err instanceof ApiError && Array.isArray(err.details) && err.details.length) {
    return `${err.message}: ${err.details.map((d) => `${d.field} - ${d.message}`).join('; ')}`;
  }
  return err?.message || 'Something went wrong';
}
