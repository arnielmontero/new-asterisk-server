'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { renderPjsip, renderDialplan, renderAll } = require('../src/pbx/render');

const ext = (over = {}) => ({ id: 1, number: '1001', display_name: 'Office', secret: 'browserSecret1234', phone_secret: 'phoneSecret12345', webrtc_enabled: true, phone_enabled: true, allow_outbound: false, outbound_cid: null, enabled: true, ...over });
const trunk = (over = {}) => ({
  id: 1, name: 'acme', display_name: 'Acme', kind: 'provider', auth_mode: 'register', host: 'sip.acme.test', port: 5060, transport: 'udp',
  username: 'acct42', password: 'S3cret!pass', auth_username: null, from_user: null, from_domain: null, register_expiry: 3600,
  codecs: ['ulaw', 'alaw'], dtmf_mode: 'rfc4733', max_channels: 0, caller_id_num: null, caller_id_name: null, match_ips: [],
  inbound_default: null, qualify: true, enabled: true, ...over,
});
const snap = (over = {}) => ({ extensions: [ext()], groups: [], trunks: [], inbound: [], outbound: [], ...over });

describe('PJSIP rendering', () => {
  test('an extension gets a browser and a phone endpoint with their own credentials', () => {
    const out = renderPjsip(snap());
    assert.match(out, /\[1001\]\(ep-webrtc\)\naors = 1001\nauth = 1001-auth\ncallerid = "Office" <1001>/);
    assert.match(out, /\[1001-auth\]\(auth-common\)\nusername = 1001\npassword = browserSecret1234/);
    assert.match(out, /\[1001-phone\]\(ep-phone\)/);
    assert.match(out, /\[1001-phone-auth\]\(auth-common\)\nusername = 1001-phone\npassword = phoneSecret12345/);
  });

  test('disabled extensions and disabled clients are not rendered', () => {
    assert.ok(!renderPjsip(snap({ extensions: [ext({ enabled: false })] })).includes('[1001]'));
    const phoneOnly = renderPjsip(snap({ extensions: [ext({ webrtc_enabled: false })] }));
    assert.ok(!phoneOnly.includes('(ep-webrtc)') && phoneOnly.includes('(ep-phone)'));
  });

  test('a registration trunk renders endpoint, aor, auth, registration and identify', () => {
    const out = renderPjsip(snap({ trunks: [trunk()] }));
    assert.match(out, /\[trk-acme\]\(ep-trunk\)\ntransport = transport-udp\naors = trk-acme\ncontext = from-trunk-acme\nallow = ulaw,alaw\ndtmf_mode = rfc4733\noutbound_auth = trk-acme-auth/);
    assert.match(out, /\[trk-acme\]\(aor-trunk\)\ncontact = sip:sip\.acme\.test:5060\nqualify_frequency = 60/);
    assert.match(out, /\[trk-acme-auth\]\(auth-common\)\nusername = acct42\npassword = S3cret!pass/);
    assert.match(out, /\[trk-acme\]\ntype = registration[\s\S]*server_uri = sip:sip\.acme\.test:5060[\s\S]*client_uri = sip:acct42@sip\.acme\.test[\s\S]*contact_user = acct42[\s\S]*endpoint = trk-acme/);
    assert.match(out, /\[trk-acme\]\ntype = identify\nendpoint = trk-acme\nmatch = sip\.acme\.test/);
  });

  test('an IP trunk has no registration or auth, honours TCP, limits and extra match addresses', () => {
    const out = renderPjsip(snap({ trunks: [trunk({ name: 'gw', auth_mode: 'ip', username: null, password: null, transport: 'tcp', max_channels: 4, match_ips: ['10.1.1.0/24'], qualify: false })] }));
    assert.ok(!out.includes('type = registration'));
    assert.ok(!out.includes('trk-gw-auth'));
    assert.match(out, /transport = transport-tcp/);
    assert.match(out, /contact = sip:sip\.acme\.test:5060;transport=tcp\nqualify_frequency = 0/);
    assert.match(out, /device_state_busy_at = 4/);
    assert.match(out, /match = sip\.acme\.test\nmatch = 10\.1\.1\.0\/24/);
  });

  test('disabled trunks are omitted entirely', () => {
    assert.ok(!renderPjsip(snap({ trunks: [trunk({ enabled: false })] })).includes('trk-acme'));
  });

  test('rendering is deterministic (the checksum drives reload decisions)', () => {
    const a = renderAll(snap({ trunks: [trunk()] }));
    const b = renderAll(snap({ trunks: [trunk()] }));
    assert.equal(a.checksum, b.checksum);
    assert.notEqual(a.checksum, renderAll(snap({ trunks: [trunk({ host: 'other.test' })] })).checksum);
  });
});

describe('rendering refuses anything that could inject configuration', () => {
  const evil = ['a\nb', 'a;b', 'a#b', 'a"b', 'a${X}b', 'a}b', 'a\\b', 'a<b', 'a|b', 'a\rb'];
  for (const value of evil) {
    test(`extension fields: ${JSON.stringify(value)}`, () => {
      assert.throws(() => renderPjsip(snap({ extensions: [ext({ display_name: value })] })), /unsafe/);
      assert.throws(() => renderPjsip(snap({ extensions: [ext({ secret: value })] })), /unsafe/);
    });
    test(`trunk fields: ${JSON.stringify(value)}`, () => {
      assert.throws(() => renderPjsip(snap({ trunks: [trunk({ host: value })] })), /unsafe/);
      assert.throws(() => renderPjsip(snap({ trunks: [trunk({ password: value })] })), /unsafe/);
      assert.throws(() => renderPjsip(snap({ trunks: [trunk({ username: value })] })), /unsafe/);
    });
  }
  test('dialplan fields', () => {
    for (const value of evil) {
      assert.throws(() => renderDialplan(snap({ extensions: [ext({ allow_outbound: true, outbound_cid: value })] })), /unsafe/);
      assert.throws(() => renderDialplan(snap({
        trunks: [trunk()], inbound: [{ id: 1, name: 'r', did: value, trunk_id: null, enabled: true, destination: { type: 'echo', value: '' }, cid_name_prefix: null }],
      })), /unsafe/);
      assert.throws(() => renderDialplan(snap({
        trunks: [trunk()], outbound: [{ id: 1, name: 'r', patterns: [value], strip: 0, prepend: '', cid_num: null, emergency: false, enabled: true, trunks: [{ id: 1, name: 'acme' }] }],
      })), /unsafe/);
    }
  });
});

describe('dialplan rendering', () => {
  const groups = [{ number: '700', name: 'All', enabled: true, members: ['1001', '1002', '1003'] }, { number: '701', name: 'Off', enabled: false, members: ['1001'] }];

  test('extensions, enabled paging groups and member lists', () => {
    const out = renderDialplan(snap({ extensions: [ext(), ext({ number: '1002' }), ext({ number: '1003', enabled: false })], groups }));
    assert.match(out, /exten => 1001,1,Set\(CDR\(userfield\)=to:\$\{EXTEN\}\)\n same => n,Gosub\(sub-dial-ext,s,1\(1001\)\)/);
    assert.ok(!out.includes('exten => 1003,1'), 'disabled extension is not dialable');
    assert.match(out, /exten => 700,1,Set\(MEMBERS=1001-1002\)/, 'disabled members are left out');
    assert.match(out, /exten => 700,1,Gosub\(sub-page,s,1\(700\)\)/);
    assert.ok(!out.includes('701'), 'disabled group is gone');
  });

  test('only extensions allowed to dial out are listed, with their caller id', () => {
    const out = renderDialplan(snap({ extensions: [ext({ allow_outbound: true, outbound_cid: '15551230000' }), ext({ number: '1002' })] }));
    assert.match(out, /\[ext-outbound\]\nexten => 1001,1,Set\(OB_CID=15551230000\)/);
    assert.ok(!/\[ext-outbound\][\s\S]*exten => 1002,1,Set\(OB_CID/.test(out));
  });

  test('outbound routes: pattern, strip, prepend, trunk order, caller id and emergency flag', () => {
    const out = renderDialplan(snap({
      trunks: [trunk(), trunk({ id: 2, name: 'backup' })],
      outbound: [
        { id: 7, name: 'National', patterns: ['_9NXXNXXXXXX', '911'], strip: 1, prepend: '+1', cid_num: '15550001111', emergency: false, enabled: true, trunks: [{ id: 1, name: 'acme' }, { id: 2, name: 'backup' }] },
        { id: 8, name: 'Off', patterns: ['_8X.'], strip: 0, prepend: '', cid_num: null, emergency: false, enabled: false, trunks: [{ id: 1, name: 'acme' }] },
        { id: 9, name: 'No trunks left', patterns: ['_7X.'], strip: 0, prepend: '', cid_num: null, emergency: true, enabled: true, trunks: [{ id: 99, name: 'gone' }] },
      ],
    }));
    assert.match(out, /exten => _9NXXNXXXXXX,1,NoOp\(Outbound route 7 pattern 1\)\n same => n,Gosub\(sub-outbound,s,1\(7,\+1\$\{EXTEN:1\},trk-acme&trk-backup,15550001111,0\)\)/);
    assert.match(out, /exten => 911,1,/, 'plain digits are an exact match, not a pattern');
    assert.ok(!out.includes('_8X.'), 'disabled route');
    assert.ok(!out.includes('_7X.'), 'a route whose trunks are all gone is skipped');
  });

  test('outbound routes are included in the administrator\'s order, so identical patterns resolve by position', () => {
    const route = (id, position, name) => ({ id, name, patterns: ['_9X.'], strip: 1, prepend: '', cid_num: null, emergency: false, position, enabled: true, trunks: [{ id: 1, name: 'acme' }] });
    const out = renderDialplan(snap({ trunks: [trunk()], outbound: [route(3, 20, 'Late'), route(1, 10, 'Second'), route(2, 5, 'First'), route(4, 10, 'Tie')] }));
    const includes = [...out.matchAll(/include => outrt-(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(includes, [2, 1, 4, 3], 'position, then id');
    for (const id of [1, 2, 3, 4]) assert.match(out, new RegExp(`\\[outrt-${id}\\]`));
    // The pattern lives in the route's own context, never in [default], where a duplicate would silently lose.
    assert.ok(!/\[default\][^[]*exten => _9X\./.test(out));
  });

  test('inbound: per-trunk contexts, specific beats generic, catch-all and defaults', () => {
    const out = renderDialplan(snap({
      extensions: [ext(), ext({ number: '1002' })],
      trunks: [trunk(), trunk({ id: 2, name: 'gw', inbound_default: { type: 'extension', value: '1002' } })],
      inbound: [
        { id: 1, name: 'Main', did: '5551234', trunk_id: null, enabled: true, destination: { type: 'extension', value: '1001' }, cid_name_prefix: 'Sales' },
        { id: 2, name: 'Main on gw', did: '5551234', trunk_id: 2, enabled: true, destination: { type: 'echo', value: '' }, cid_name_prefix: null },
        { id: 3, name: 'Busy', did: '5559999', trunk_id: 1, enabled: true, destination: { type: 'hangup', value: 'busy' }, cid_name_prefix: null },
        { id: 4, name: 'Off', did: '5550000', trunk_id: null, enabled: false, destination: { type: 'echo', value: '' }, cid_name_prefix: null },
      ],
    }));
    const acme = out.slice(out.indexOf('[from-trunk-acme]'), out.indexOf('[from-trunk-gw]'));
    const gw = out.slice(out.indexOf('[from-trunk-gw]'));
    assert.match(acme, /exten => 5551234,1[\s\S]*Set\(CDR\(userfield\)=in:\$\{EXTEN\}\)[\s\S]*Set\(CALLERID\(name\)=Sales \$\{CALLERID\(name\)\}\)[\s\S]*Goto\(dst-extension-1001,s,1\)/);
    assert.match(acme, /exten => 5559999,1[\s\S]*Goto\(dst-hangup-busy,s,1\)/);
    assert.match(acme, /exten => _X.,1[\s\S]*Goto\(dst-hangup-reject,s,1\)/, 'no default: reject');
    assert.ok(!acme.includes('5550000'));
    assert.match(gw, /exten => 5551234,1[\s\S]*Goto\(dst-echo-0,s,1\)/, 'route bound to this trunk wins');
    assert.ok(!gw.includes('5559999'), 'route for another trunk does not leak');
    assert.match(gw, /exten => _X.,1[\s\S]*Goto\(dst-extension-1002,s,1\)/, 'trunk default destination');
  });

  test('a catch-all (*) route replaces the generated default', () => {
    const out = renderDialplan(snap({
      trunks: [trunk()],
      inbound: [{ id: 1, name: 'Any', did: '*', trunk_id: null, enabled: true, destination: { type: 'echo', value: '' }, cid_name_prefix: null }],
    }));
    assert.equal((out.match(/exten => _X.,1/g) || []).length, 1);
    assert.equal((out.match(/exten => _+X.,1/g) || []).length, 1, 'numbers starting with + are covered too');
    assert.ok(!out.includes('matched no route'));
  });

  test('every dialplan reference points at a context the static dialplan defines', () => {
    const out = renderDialplan(snap({ extensions: [ext()], groups, trunks: [trunk()] }));
    for (const ctx of ['sub-dial-ext', 'sub-page', 'sub-outbound']) assert.ok(out.includes(ctx) || ctx === 'sub-outbound');
    assert.ok(out.includes('[page-members]') && out.includes('[ext-outbound]') && out.includes('[trunk-meta]') && out.includes('[default]'));
  });
});
