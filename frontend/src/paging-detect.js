// Decides whether an incoming SIP INVITE is a page that may be auto-answered.
// Pure function so it can be unit-tested without a browser.

export const PAGING_CALLERS = Object.freeze(['700', '701', '702']);

// "Call-Info: <sip:host>;answer-after=0" - the parameter must be exactly answer-after=0.
const ANSWER_AFTER_ZERO = /(?:^|[;,\s])answer-after=0(?=\s*(?:[;,]|$))/i;

/**
 * Auto-answer only when ALL of these hold (a generic Call-Info header alone is never enough):
 *   1. the caller is one of the known paging groups (700/701/702)
 *   2. X-Paging-Call is exactly "true"
 *   3. Call-Info carries the answer-after=0 auto-answer marker
 * The remote party's identity is whatever Asterisk presents (From user), so the
 * three conditions are checked together; anything else rings normally.
 */
export function isPagingInvite({ callerUser, pagingHeader, callInfoHeader }) {
  if (!PAGING_CALLERS.includes(String(callerUser))) return false;
  if (typeof pagingHeader !== 'string' || pagingHeader.trim() !== 'true') return false;
  if (typeof callInfoHeader !== 'string' || !ANSWER_AFTER_ZERO.test(callInfoHeader)) return false;
  return true;
}
