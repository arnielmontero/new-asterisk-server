// The paging auto-answer gate decides whether a browser answers a call without
// the user pressing anything, so it is tested exhaustively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPagingInvite, PAGING_CALLERS } from '../src/paging-detect.js';

const good = { callerUser: '700', pagingHeader: 'true', callInfoHeader: '<sip:communications.local>;answer-after=0' };

test('a genuine page from each paging group is auto-answered', () => {
  for (const g of PAGING_CALLERS) assert.equal(isPagingInvite({ ...good, callerUser: g }), true, g);
});

test('Call-Info with extra parameters / ordering still matches', () => {
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>;answer-after=0;purpose=info' }), true);
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>;purpose=info;answer-after=0' }), true);
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>; answer-after=0' }), true);
});

test('an ordinary call between extensions never auto-answers', () => {
  assert.equal(isPagingInvite({ callerUser: '1001', pagingHeader: undefined, callInfoHeader: undefined }), false);
  assert.equal(isPagingInvite({ callerUser: '1002', pagingHeader: undefined, callInfoHeader: '<sip:x>;answer-after=0' }), false);
});

test('each required condition is individually necessary', () => {
  assert.equal(isPagingInvite({ ...good, callerUser: '1001' }), false, 'caller must be a paging group');
  assert.equal(isPagingInvite({ ...good, callerUser: '703' }), false, 'unknown group');
  assert.equal(isPagingInvite({ ...good, callerUser: '70' }), false);
  assert.equal(isPagingInvite({ ...good, pagingHeader: undefined }), false, 'X-Paging-Call is required');
  assert.equal(isPagingInvite({ ...good, pagingHeader: 'false' }), false);
  assert.equal(isPagingInvite({ ...good, pagingHeader: 'TRUE' }), false, 'must be exactly "true"');
  assert.equal(isPagingInvite({ ...good, pagingHeader: 'true ; x' }), false);
  assert.equal(isPagingInvite({ ...good, pagingHeader: '' }), false);
  assert.equal(isPagingInvite({ ...good, callInfoHeader: undefined }), false, 'Call-Info is required');
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '' }), false);
});

test('a generic Call-Info header without the auto-answer marker is not enough', () => {
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>;purpose=icon' }), false);
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>;answer-after=5' }), false);
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>;answer-after=00' }), false);
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>;answer-after=0x' }), false);
  assert.equal(isPagingInvite({ ...good, callInfoHeader: '<sip:x>;not-answer-after=0' }), false);
});

test('non-string / odd inputs are rejected safely', () => {
  assert.equal(isPagingInvite({ callerUser: 700, pagingHeader: true, callInfoHeader: 5 }), false);
  assert.equal(isPagingInvite({ callerUser: null, pagingHeader: null, callInfoHeader: null }), false);
  assert.equal(isPagingInvite({}), false);
});
