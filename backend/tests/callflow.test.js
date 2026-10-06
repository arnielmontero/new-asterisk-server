'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, auditCount } = require('./helpers');
const { renderDialplan } = require('../src/pbx/render');

describe('call flow: ring groups, time conditions, forwarding and do not disturb', () => {
  let h; let admin; let operator; let plain;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.flow', role: 'operator', extension: '1001' });
    plain = await h.makeUser({ username: 'plain.flow', role: 'user' });
    await h.store.createExtension({ number: '1003', display_name: 'Third', webrtc_enabled: true, phone_enabled: true, allow_outbound: false, outbound_cid: null, enabled: true, notes: null });
  });
  after(async () => h.cleanup());

  const post = (url, body, who = admin) => h.agent().post(`/api/pbx${url}`).set(who.auth).send(body);
  const patch = (url, body, who = admin) => h.agent().patch(`/api/pbx${url}`).set(who.auth).send(body);
  const get = (url, who = admin) => h.agent().get(`/api/pbx${url}`).set(who.auth);
  const del = (url, who = admin) => h.agent().delete(`/api/pbx${url}`).set(who.auth);

  describe('ring groups', () => {
    test('create keeps the member order; strategies and timing are validated', async () => {
      const res = await post('/ring-groups', { number: '800', name: 'Sales', strategy: 'sequential', ring_secs: 15, members: ['1002', '1001', '1003'] });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.group.members, ['1002', '1001', '1003'], 'order is the ring order');
      assert.equal(res.body.group.strategy, 'sequential');
      for (const bad of [
        { number: '801', name: 'x', members: [] },
        { number: '801', name: 'x', members: ['1001'], strategy: 'random' },
        { number: '801', name: 'x', members: ['1001'], ring_secs: 2 },
        { number: '801', name: 'x', members: ['1001'], ring_secs: 500 },
        { number: '801', name: 'x', members: ['9999'] },
        { number: '801', name: 'bad;name', members: ['1001'] },
        { number: '8', name: 'x', members: ['1001'] },
        { number: '801', name: 'x', members: ['1001'], unknown: 1 },
        { number: '801', name: 'x', members: ['1001'], fail_dest: { type: 'extension', value: '4242' } },
        { number: '801', name: 'x', members: ['1001'], fail_dest: { type: 'shell', value: 'rm' } },
      ]) {
        assert.equal((await post('/ring-groups', bad)).status, 400, JSON.stringify(bad));
      }
    });

    test('numbers are shared with extensions, paging groups and each other', async () => {
      assert.equal((await post('/ring-groups', { number: '1001', name: 'Clash', members: ['1001'] })).status, 409);
      assert.equal((await post('/ring-groups', { number: '700', name: 'Clash', members: ['1001'] })).status, 409);
      assert.equal((await post('/ring-groups', { number: '800', name: 'Clash', members: ['1001'] })).status, 409);
      assert.equal((await post('/ring-groups', { number: '600', name: 'Clash', members: ['1001'] })).status, 409);
      assert.equal((await post('/extensions', { number: '800', display_name: 'Clash' })).status, 409, 'an extension cannot take a ring group number');
      assert.equal((await post('/paging-groups', { number: '800', name: 'Clash', members: [] })).status, 409);
    });

    test('update members, fallback and disable; a group cannot fall back to itself', async () => {
      const id = (await get('/ring-groups')).body.groups.find((g) => g.number === '800').id;
      const upd = await patch(`/ring-groups/${id}`, { members: ['1001'], fail_dest: { type: 'extension', value: '1003' }, strategy: 'ringall' });
      assert.equal(upd.status, 200);
      assert.deepEqual(upd.body.group.members, ['1001']);
      assert.deepEqual(upd.body.group.fail_dest, { type: 'extension', value: '1003' });
      assert.equal((await patch(`/ring-groups/${id}`, { fail_dest: { type: 'ringgroup', value: '800' } })).status, 400);
      assert.equal((await patch(`/ring-groups/${id}`, {})).status, 400);
    });

    test('a ring group that a route or another group uses cannot be deleted; an unused one can', async () => {
      const g = (await get('/ring-groups')).body.groups.find((x) => x.number === '800');
      await post('/trunks', { name: 'rgt', display_name: 'RG trunk', auth_mode: 'ip', host: '10.9.9.9' });
      const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'rgt');
      const route = await post('/inbound-routes', { name: 'to rg', did: '5558000', trunk_id: trunk.id, destination: { type: 'ringgroup', value: '800' } });
      assert.equal(route.status, 201);
      const blocked = await del(`/ring-groups/${g.id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /inbound route "to rg"/);
      await del(`/inbound-routes/${route.body.route.id}`);
      assert.equal((await del(`/ring-groups/${g.id}`)).status, 200);
    });

    test('a ring group can be an inbound destination, a trunk default and an extension forward target', async () => {
      const made = await post('/ring-groups', { number: '810', name: 'Support', members: ['1001', '1002'] });
      assert.equal(made.status, 201);
      const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'rgt');
      assert.equal((await patch(`/trunks/${trunk.id}`, { inbound_default: { type: 'ringgroup', value: '810' } })).status, 200);
      const ext = (await get('/extensions')).body.extensions.find((e) => e.number === '1003');
      assert.equal((await patch(`/extensions/${ext.id}`, { fwd_noanswer: { type: 'ringgroup', value: '810' } })).status, 200);
      const del2 = await del(`/ring-groups/${made.body.group.id}`);
      assert.equal(del2.status, 409);
      assert.match(del2.body.error.message, /trunk "rgt" default destination/);
      assert.match(del2.body.error.message, /extension 1003 forwarding/);
    });

    test('operators cannot manage ring groups', async () => {
      assert.equal((await get('/ring-groups', operator)).status, 403);
      assert.equal((await post('/ring-groups', { number: '820', name: 'X', members: ['1001'] }, operator)).status, 403);
    });
  });

  describe('time conditions', () => {
    const body = (over = {}) => ({
      name: 'Office hours', timezone: 'America/New_York',
      rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' }],
      holidays: [{ month: 12, day: 25, name: 'Christmas' }],
      match_dest: { type: 'extension', value: '1001' }, nomatch_dest: { type: 'hangup', value: 'busy' }, ...over,
    });

    test('create, read back and the destinations must exist', async () => {
      const res = await post('/time-conditions', body());
      assert.equal(res.status, 201);
      assert.equal(res.body.condition.override, 'auto');
      assert.equal(res.body.condition.timezone, 'America/New_York');
      assert.equal((await post('/time-conditions', body({ name: 'Ghost', match_dest: { type: 'extension', value: '4242' } }))).status, 400);
      assert.equal((await post('/time-conditions', body({ name: 'Ghost2', nomatch_dest: { type: 'timecondition', value: '9999' } }))).status, 400);
      assert.equal((await post('/time-conditions', body())).status, 409, 'duplicate name');
    });

    test('validation: time zone, times, days, holidays and dangerous text', async () => {
      for (const bad of [
        body({ name: 'a', timezone: 'Mars/Olympus' }),
        body({ name: 'b', timezone: 'UTC;Hangup()' }),
        body({ name: 'c', timezone: '../../etc/passwd' }),
        body({ name: 'd', rules: [{ days: ['mon'], from: '25:00', to: '17:00' }] }),
        body({ name: 'e', rules: [{ days: ['mon'], from: '09:00', to: '09:00' }] }),
        body({ name: 'f', rules: [{ days: [], from: '09:00', to: '17:00' }] }),
        body({ name: 'g', rules: [{ days: ['someday'], from: '09:00', to: '17:00' }] }),
        body({ name: 'h', holidays: [{ month: 13, day: 1 }] }),
        body({ name: 'i', holidays: [{ month: 1, day: 32 }] }),
        body({ name: 'j', holidays: [{ month: 1, day: 1, name: 'x";Hangup()' }] }),
        body({ name: 'k', override: 'maybe' }),
        { ...body({ name: 'l' }), extra: 1 },
      ]) {
        assert.equal((await post('/time-conditions', bad)).status, 400, JSON.stringify(bad).slice(0, 100));
      }
      assert.equal((await post('/time-conditions', body({ name: 'No rules', rules: [] }))).status, 201, 'a condition with no rules is simply always closed');
    });

    test('the manual override is a one-field change and is audited separately', async () => {
      const id = (await get('/time-conditions')).body.conditions.find((c) => c.name === 'Office hours').id;
      const res = await patch(`/time-conditions/${id}`, { override: 'closed' });
      assert.equal(res.status, 200);
      assert.equal(res.body.condition.override, 'closed');
      assert.equal(await auditCount(h.db, "action = 'pbx.time_condition.override' AND target = 'Office hours'"), 1);
      await h.applier.apply('t');
      const files = require('node:fs').readFileSync(require('node:path').join(h.generatedDir, 'extensions_generated.conf'), 'utf8');
      const ctx = files.slice(files.indexOf(`[dst-timecondition-${id}]`));
      assert.ok(!ctx.slice(0, ctx.indexOf('\n\n')).includes('GotoIfTime'), 'override closed skips the schedule');
      await patch(`/time-conditions/${id}`, { override: 'auto' });
    });

    test('a time condition cannot route to itself; a referenced one cannot be deleted', async () => {
      const id = (await get('/time-conditions')).body.conditions.find((c) => c.name === 'Office hours').id;
      assert.equal((await patch(`/time-conditions/${id}`, { match_dest: { type: 'timecondition', value: String(id) } })).status, 400);
      const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'rgt');
      const route = await post('/inbound-routes', { name: 'by hours', did: '5558001', trunk_id: trunk.id, destination: { type: 'timecondition', value: String(id) } });
      assert.equal(route.status, 201);
      const blocked = await del(`/time-conditions/${id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /inbound route "by hours"/);
      await del(`/inbound-routes/${route.body.route.id}`);
      assert.equal((await del(`/time-conditions/${id}`)).status, 200);
    });
  });

  describe('forwarding and do not disturb', () => {
    test('an administrator sets them on any extension; invalid targets are refused', async () => {
      const ext = (await get('/extensions')).body.extensions.find((e) => e.number === '1002');
      const ok = await patch(`/extensions/${ext.id}`, { dnd: true, fwd_busy: { type: 'extension', value: '1003' }, noanswer_secs: 40 });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.extension.dnd, true);
      assert.deepEqual(ok.body.extension.fwd_busy, { type: 'extension', value: '1003' });
      assert.equal(ok.body.extension.noanswer_secs, 40);
      assert.equal((await patch(`/extensions/${ext.id}`, { fwd_all: { type: 'extension', value: '1002' } })).status, 400, 'not to itself');
      assert.equal((await patch(`/extensions/${ext.id}`, { fwd_all: { type: 'extension', value: '4242' } })).status, 400);
      assert.equal((await patch(`/extensions/${ext.id}`, { noanswer_secs: 1 })).status, 400);
      assert.equal((await patch(`/extensions/${ext.id}`, { dnd: 'yes' })).status, 400);
      assert.equal((await patch(`/extensions/${ext.id}`, { fwd_busy: null })).status, 200, 'clearing a forward');
    });

    test('an extension that others forward to cannot be deleted', async () => {
      const ext1002 = (await get('/extensions')).body.extensions.find((e) => e.number === '1002');
      const ext1003 = (await get('/extensions')).body.extensions.find((e) => e.number === '1003');
      await patch(`/extensions/${ext1002.id}`, { fwd_all: { type: 'extension', value: '1003' } });
      const blocked = await del(`/extensions/${ext1003.id}`);
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error.message, /extension 1002 forwarding/);
      await patch(`/extensions/${ext1002.id}`, { fwd_all: null, dnd: false });
    });

    test('operators manage only their own extension, only these fields', async () => {
      const get1 = await h.agent().get('/api/my/extension').set(operator.auth);
      assert.equal(get1.status, 200);
      assert.equal(get1.body.extension.number, '1001');
      const on = await h.agent().patch('/api/my/extension').set(operator.auth).send({ dnd: true });
      assert.equal(on.status, 200);
      assert.equal(on.body.extension.dnd, true);
      assert.equal(await auditCount(h.db, "action = 'extension.self.update' AND username = 'op.flow'"), 1);
      for (const forbidden of [{ number: '1002' }, { secret: 'x'.repeat(20) }, { allow_outbound: true }, { enabled: false }, { display_name: 'x' }, {}]) {
        assert.equal((await h.agent().patch('/api/my/extension').set(operator.auth).send(forbidden)).status, 400, JSON.stringify(forbidden));
      }
      assert.equal((await h.store.getExtensionSecretsByNumber('1001')).secret, 'ext1001-test-password');
      assert.equal((await h.agent().get('/api/my/extension').set(plain.auth)).status, 403);
      assert.equal((await h.agent().patch('/api/my/extension').set(plain.auth).send({ dnd: true })).status, 403);
      assert.equal((await h.agent().get('/api/my/extension')).status, 401);
      await h.agent().patch('/api/my/extension').set(operator.auth).send({ dnd: false });
    });
  });

  describe('rendering', () => {
    const ext = (number, over = {}) => ({ id: Number(number), number, display_name: `E${number}`, secret: 'a'.repeat(14), phone_secret: 'b'.repeat(14), webrtc_enabled: true, phone_enabled: true, allow_outbound: false, outbound_cid: null, enabled: true, dnd: false, fwd_all: null, fwd_busy: null, fwd_noanswer: null, noanswer_secs: 25, ...over });
    const render = (over) => renderDialplan({ extensions: [ext('1001'), ext('1002')], groups: [], trunks: [], inbound: [], outbound: [], ringGroups: [], timeConditions: [], ...over });

    test('per-extension settings carry dnd, forwards (as context names) and the ring time', () => {
      const out = render({ extensions: [ext('1001', { dnd: true, fwd_all: { type: 'extension', value: '1002' }, fwd_busy: { type: 'ringgroup', value: '800' }, fwd_noanswer: { type: 'hangup', value: 'busy' }, noanswer_secs: 40 }), ext('1002')] });
      const block = out.slice(out.indexOf('[ext-settings]'), out.indexOf('[trunk-meta]'));
      assert.match(block, /exten => 1001,1,Set\(X_DND=1\)\n same => n,Set\(X_FWD_ALL=dst-extension-1002\)\n same => n,Set\(X_FWD_BUSY=dst-ringgroup-800\)\n same => n,Set\(X_FWD_NA=dst-hangup-busy\)\n same => n,Set\(X_NA_SECS=40\)/);
      assert.match(block, /exten => 1002,1,Set\(X_DND=0\)\n same => n,Set\(X_FWD_ALL=\)/);
    });

    test('every destination type has a context and every context starts with the hop counter', () => {
      const out = render({
        ringGroups: [{ id: 1, number: '800', name: 'S', strategy: 'ringall', ring_secs: 20, members: ['1001'], fail_dest: null, enabled: true }],
        timeConditions: [{ id: 5, name: 'T', timezone: 'UTC', rules: [], holidays: [], match_dest: { type: 'echo', value: '' }, nomatch_dest: { type: 'echo', value: '' }, override: 'auto', enabled: true }],
      });
      for (const name of ['dst-echo-0', 'dst-hangup-reject', 'dst-hangup-busy', 'dst-hangup-congestion', 'dst-extension-1001', 'dst-extension-1002', 'dst-ringgroup-800', 'dst-timecondition-5']) {
        const i = out.indexOf(`[${name}]`);
        assert.ok(i >= 0, name);
        assert.match(out.slice(i, i + 200), /Gosub\(sub-hop,s,1\)/, name);
      }
    });

    test('ring all dials every reachable member at once; sequential tries them in order; both fall back', () => {
      const rg = (strategy, over = {}) => ({ id: 1, number: '800', name: 'S', strategy, ring_secs: 15, members: ['1002', '1001'], fail_dest: { type: 'extension', value: '1001' }, enabled: true, ...over });
      const all = render({ ringGroups: [rg('ringall')] });
      const a = all.slice(all.indexOf('[dst-ringgroup-800]'));
      assert.match(a, /Gosub\(sub-rg-add,s,1\(1002\)\)[\s\S]*Gosub\(sub-rg-add,s,1\(1001\)\)[\s\S]*Dial\(\$\{RG_TARGETS\},15\)[\s\S]*Goto\(dst-extension-1001,s,1\)/);
      const seq = render({ ringGroups: [rg('sequential')] });
      const q = seq.slice(seq.indexOf('[dst-ringgroup-800]'));
      assert.ok(q.indexOf('sub-dialstr,s,1(1002,1)') < q.indexOf('sub-dialstr,s,1(1001,1)'), 'member order');
      assert.equal((q.match(/Dial\(\$\{DIALSTR\},15\)/g) || []).length, 2);
      const disabled = render({ ringGroups: [rg('ringall', { enabled: false })] });
      assert.match(disabled.slice(disabled.indexOf('[dst-ringgroup-800]')), /Hangup\(21\)/);
      assert.ok(!disabled.includes('exten => 800,1'), 'a disabled group is not dialable');
      assert.match(all, /exten => 800,1,Set\(CDR\(userfield\)=to:\$\{EXTEN\}\)\n same => n,Goto\(dst-ringgroup-800,s,1\)/, 'dialable internally');
    });

    test('time conditions: holidays first, then each open day, otherwise the closed destination', () => {
      const tc = (over = {}) => ({ id: 3, name: 'T', timezone: 'Europe/Berlin', rules: [{ days: ['mon', 'wed'], from: '08:30', to: '12:00' }], holidays: [{ month: 1, day: 1, name: 'NY' }], match_dest: { type: 'extension', value: '1001' }, nomatch_dest: { type: 'extension', value: '1002' }, override: 'auto', enabled: true, ...over });
      const out = render({ timeConditions: [tc()] });
      const c = out.slice(out.indexOf('[dst-timecondition-3]'));
      assert.ok(c.indexOf('GotoIfTime(*,*,1,jan,Europe/Berlin?closed)') < c.indexOf('GotoIfTime(08:30-12:00,mon'), 'holiday wins');
      assert.match(c, /GotoIfTime\(08:30-12:00,mon,\*,\*,Europe\/Berlin\?open\)\n same => n,GotoIfTime\(08:30-12:00,wed/);
      assert.match(c, /\(open\),NoOp\(open\)\n same => n,Goto\(dst-extension-1001,s,1\)/);
      assert.match(c, /\(closed\),NoOp\(closed\)\n same => n,Goto\(dst-extension-1002,s,1\)/);
      const open = render({ timeConditions: [tc({ override: 'open' })] });
      const o = open.slice(open.indexOf('[dst-timecondition-3]'));
      assert.ok(!o.slice(0, o.indexOf('\n\n')).includes('GotoIfTime'));
      assert.match(o, /Goto\(dst-extension-1001,s,1\)/);
    });

    test('unsafe values in the new objects are refused', () => {
      assert.throws(() => render({ timeConditions: [{ id: 3, name: 'T', timezone: 'UTC;Hangup()', rules: [], holidays: [], match_dest: { type: 'echo', value: '' }, nomatch_dest: { type: 'echo', value: '' }, override: 'auto', enabled: true }] }), /unsafe/);
      assert.throws(() => render({ extensions: [ext('1001', { fwd_all: { type: 'extension', value: '1002\nHangup()' } })] }), /unsafe/);
      assert.throws(() => render({ ringGroups: [{ id: 1, number: '800\nx', name: 'S', strategy: 'ringall', ring_secs: 15, members: ['1001'], fail_dest: null, enabled: true }] }), /unsafe/);
    });
  });

  describe('applying call-flow changes', () => {
    test('a dialplan-only change reloads the dialplan and leaves PJSIP (registrations, trunks) alone', async () => {
      await h.applier.apply('baseline', { force: true });
      h.ami.reset();
      const ext = (await get('/extensions')).body.extensions.find((e) => e.number === '1002');
      assert.equal((await patch(`/extensions/${ext.id}`, { dnd: true })).status, 200);
      await new Promise((r) => setTimeout(r, 600));
      const cmds = h.ami.callsFor('Command').map((c) => c.Command);
      assert.deepEqual(cmds, ['dialplan reload']);
      h.ami.reset();
      assert.equal((await patch(`/extensions/${ext.id}`, { display_name: 'Renamed' })).status, 200);
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(h.ami.callsFor('Command').some((c) => c.Command === 'module reload res_pjsip.so'), 'a caller-id change touches PJSIP');
    });
  });
});
