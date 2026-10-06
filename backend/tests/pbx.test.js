'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, auditCount } = require('./helpers');

describe('PBX management API', () => {
  let h; let admin; let operator;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.pbx', role: 'operator', extension: '1001' });
  });
  after(async () => h.cleanup());

  const post = (url, body, who = admin) => h.agent().post(`/api/pbx${url}`).set(who.auth).send(body);
  const patch = (url, body, who = admin) => h.agent().patch(`/api/pbx${url}`).set(who.auth).send(body);
  const get = (url, who = admin) => h.agent().get(`/api/pbx${url}`).set(who.auth);
  const del = (url, who = admin) => h.agent().delete(`/api/pbx${url}`).set(who.auth);

  describe('access control', () => {
    test('only administrators can use the PBX API', async () => {
      for (const url of ['/extensions', '/trunks', '/inbound-routes', '/outbound-routes', '/paging-groups', '/apply']) {
        assert.equal((await get(url, operator)).status, 403, url);
        assert.equal((await h.agent().get(`/api/pbx${url}`)).status, 401, url);
      }
      assert.equal((await post('/extensions', { number: '1500', display_name: 'X' }, operator)).status, 403);
    });
  });

  describe('extensions', () => {
    test('the two original extensions are seeded with their environment credentials', async () => {
      const list = (await get('/extensions')).body.extensions;
      assert.deepEqual(list.map((e) => e.number), ['1001', '1002']);
      const secrets = await h.store.getExtensionSecretsByNumber('1001');
      assert.equal(secrets.secret, 'ext1001-test-password');
      assert.equal(secrets.phone_secret, 'phone1001-test-password');
    });

    test('create generates strong secrets, never returns them in the list and audits the change', async () => {
      const res = await post('/extensions', { number: '1100', display_name: 'Front Desk', allow_outbound: true });
      assert.equal(res.status, 201);
      assert.equal(res.body.extension.number, '1100');
      assert.equal(res.body.extension.secret, undefined);
      assert.equal(res.body.extension.phone_secret, undefined);
      const s = await h.store.getExtensionSecretsByNumber('1100');
      assert.match(s.secret, /^[A-Za-z0-9]{20}$/);
      assert.match(s.phone_secret, /^[A-Za-z0-9]{20}$/);
      assert.notEqual(s.secret, s.phone_secret);
      const listed = JSON.stringify((await get('/extensions')).body);
      assert.ok(!listed.includes(s.secret) && !listed.includes(s.phone_secret));
      assert.equal(await auditCount(h.db, "action = 'pbx.extension.create' AND target = '1100' AND status = 'success'"), 1);
    });

    test('new extensions become live in the registry (and so in state and paging)', async () => {
      await h.applier.apply('test');
      assert.ok(h.registry.isExtension('1100'));
      assert.ok(h.state.snapshot().some((e) => e.extension === '1100'));
    });

    test('invalid or dangerous input is rejected and nothing is stored', async () => {
      const bad = [
        { number: '12', display_name: 'Short' },
        { number: '1234567', display_name: 'Long' },
        { number: '12a4', display_name: 'Letters' },
        { number: '1200', display_name: 'Quote " injection' },
        { number: '1200', display_name: 'Semi;colon' },
        { number: '1200', display_name: 'New\nline' },
        { number: '1200', display_name: 'Dollar ${EXEC}' },
        { number: '1200', display_name: '' },
        { number: '1200', display_name: 'x'.repeat(41) },
        { number: '1200', display_name: 'ok', secret: 'short' },
        { number: '1200', display_name: 'ok', secret: 'has space in secret!' },
        { number: '1200', display_name: 'ok', secret: 'semi;colon-secret-12345' },
        { number: '1200', display_name: 'ok', outbound_cid: 'abc' },
        { number: '1200', display_name: 'ok', is_admin: true },
        { display_name: 'no number' },
      ];
      for (const body of bad) {
        const res = await post('/extensions', body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      assert.equal((await get('/extensions')).body.extensions.some((e) => e.number === '1200'), false);
    });

    test('duplicate, reserved and group numbers are refused', async () => {
      assert.equal((await post('/extensions', { number: '1100', display_name: 'Dup' })).status, 409);
      const echo = await post('/extensions', { number: '600', display_name: 'Echo' });
      assert.equal(echo.status, 409);
      assert.equal(echo.body.error.code, 'number_reserved');
      const grp = await post('/extensions', { number: '700', display_name: 'Group' });
      assert.equal(grp.status, 409);
      assert.equal(grp.body.error.code, 'number_in_use');
    });

    test('update changes fields but the number is immutable', async () => {
      const id = (await get('/extensions')).body.extensions.find((e) => e.number === '1100').id;
      const ok = await patch(`/extensions/${id}`, { display_name: 'Reception', allow_outbound: false, outbound_cid: '15551230000' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.extension.display_name, 'Reception');
      assert.equal(ok.body.extension.outbound_cid, '15551230000');
      assert.equal((await patch(`/extensions/${id}`, { number: '1101' })).status, 400);
      assert.equal((await patch(`/extensions/${id}`, {})).status, 400);
    });

    test('credentials are shown only on request and the view is audited; regenerate replaces them', async () => {
      const id = (await get('/extensions')).body.extensions.find((e) => e.number === '1100').id;
      const before = await h.store.getExtensionSecretsByNumber('1100');
      const view = await get(`/extensions/${id}/credentials`);
      assert.equal(view.status, 200);
      assert.equal(view.body.browser.password, before.secret);
      assert.equal(view.body.phone.username, '1100-phone');
      assert.equal(view.body.phone.password, before.phone_secret);
      assert.match(view.headers['cache-control'], /no-store/);
      assert.equal(await auditCount(h.db, "action = 'pbx.extension.credentials.view' AND target = '1100'"), 1);

      const regen = await post(`/extensions/${id}/regenerate-secret`, { which: 'phone' });
      assert.equal(regen.status, 200);
      const after = await h.store.getExtensionSecretsByNumber('1100');
      assert.equal(after.secret, before.secret, 'browser secret untouched');
      assert.notEqual(after.phone_secret, before.phone_secret);
      assert.equal((await post(`/extensions/${id}/regenerate-secret`, { which: 'bogus' })).status, 400);
    });

    test('an extension can be assigned to a user and an unassigned one is refused', async () => {
      const ok = await h.agent().post('/api/users').set(admin.auth).send({ username: 'desk.user', password: 'a-long-enough-passphrase', role: 'operator', extension: '1100' });
      assert.equal(ok.status, 201);
      const ghost = await h.agent().post('/api/users').set(admin.auth).send({ username: 'ghost.user', password: 'a-long-enough-passphrase', role: 'operator', extension: '1999' });
      assert.equal(ghost.status, 400);
      const listed = (await get('/extensions')).body.extensions.find((e) => e.number === '1100');
      assert.equal(listed.user, 'desk.user');
    });

    test('the softphone configuration comes from the database for any extension', async () => {
      const login = await h.login('desk.user', 'a-long-enough-passphrase');
      const cfg = await h.agent().get('/api/sip/config').set({ Authorization: `Bearer ${login.body.token}` });
      assert.equal(cfg.status, 200);
      assert.equal(cfg.body.extension, '1100');
      assert.equal(cfg.body.displayName, 'Reception');
      const s = await h.store.getExtensionSecretsByNumber('1100');
      assert.equal(cfg.body.password, s.secret);
    });

    test('deleting an extension unassigns its user and removes it from groups', async () => {
      const id = (await get('/extensions')).body.extensions.find((e) => e.number === '1100').id;
      const g = await post('/paging-groups', { number: '710', name: 'Desk', members: ['1100', '1001'] });
      assert.equal(g.status, 201);
      assert.equal((await del(`/extensions/${id}`)).status, 200);
      const user = await h.users.findAuthByUsername('desk.user');
      assert.equal(user.extension, null);
      const groups = (await get('/paging-groups')).body.groups;
      assert.deepEqual(groups.find((x) => x.number === '710').members, ['1001']);
      assert.equal((await del(`/extensions/${id}`)).status, 404);
    });

    test('an extension that an inbound route sends calls to cannot be deleted', async () => {
      await post('/extensions', { number: '1300', display_name: 'Target' });
      await post('/trunks', { name: 'tk1', display_name: 'T1', auth_mode: 'ip', host: '10.0.0.5' });
      const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'tk1');
      const route = await post('/inbound-routes', { name: 'to 1300', did: '5550001', trunk_id: trunk.id, destination: { type: 'extension', value: '1300' } });
      assert.equal(route.status, 201);
      const id = (await get('/extensions')).body.extensions.find((e) => e.number === '1300').id;
      const res = await del(`/extensions/${id}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'in_use');
      assert.ok((await auditCount(h.db, "action = 'pbx.extension.delete' AND status = 'failure' AND details->>'reason' = 'in_use'")) >= 1);
    });
  });

  describe('paging groups', () => {
    test('create, update membership, disable and delete', async () => {
      const made = await post('/paging-groups', { number: '720', name: 'Warehouse and Office', members: ['1001', '1002'] });
      assert.equal(made.status, 201);
      const id = made.body.group.id;
      assert.deepEqual(made.body.group.members, ['1001', '1002']);
      const upd = await patch(`/paging-groups/${id}`, { members: ['1002'], name: 'Just warehouse' });
      assert.deepEqual(upd.body.group.members, ['1002']);
      assert.equal((await patch(`/paging-groups/${id}`, { members: ['4040'] })).status, 400, 'unknown member');
      await patch(`/paging-groups/${id}`, { enabled: false });
      await h.applier.apply('test');
      assert.equal(h.registry.isPagingGroup('720'), false, 'disabled groups are not pageable');
      assert.equal((await del(`/paging-groups/${id}`)).status, 200);
    });

    test('group numbers cannot clash with extensions or other groups', async () => {
      assert.equal((await post('/paging-groups', { number: '1001', name: 'Clash', members: [] })).status, 409);
      assert.equal((await post('/paging-groups', { number: '700', name: 'Clash', members: [] })).status, 409);
    });
  });

  describe('trunks', () => {
    const base = { name: 'acme', display_name: 'Acme VoIP', auth_mode: 'register', host: 'sip.acme.test', username: 'acct42', password: 'S3cret!pass' };

    test('a registration trunk is stored; the password is never returned', async () => {
      const res = await post('/trunks', base);
      assert.equal(res.status, 201);
      assert.equal(res.body.trunk.password, undefined);
      assert.equal(res.body.trunk.has_password, true);
      assert.equal(res.body.trunk.port, 5060);
      assert.deepEqual(res.body.trunk.codecs, ['ulaw', 'alaw']);
      assert.ok(!JSON.stringify((await get('/trunks')).body).includes('S3cret!pass'));
      const audit = await h.db.query("SELECT details FROM audit_logs WHERE action = 'pbx.trunk.create' AND target = 'acme'");
      assert.ok(!JSON.stringify(audit.rows).includes('S3cret'), 'passwords are never audited');
    });

    test('validation: required fields per auth mode, dangerous characters, bad hosts', async () => {
      const bad = [
        { ...base, name: 'bad1', username: null },
        { ...base, name: 'bad2', password: null },
        { ...base, name: 'Bad3' },
        { ...base, name: '1abc' },
        { ...base, name: 'bad5', host: 'host with spaces' },
        { ...base, name: 'bad6', host: 'x.test;\nAction: Command' },
        { ...base, name: 'bad7', password: 'pass;word' },
        { ...base, name: 'bad8', password: 'pass word' },
        { ...base, name: 'bad9', password: 'pa"ss' },
        { ...base, name: 'bad10', username: 'user\r\nx: y' },
        { ...base, name: 'bad11', port: 70000 },
        { ...base, name: 'bad12', codecs: [] },
        { ...base, name: 'bad13', codecs: ['evil'] },
        { ...base, name: 'bad14', transport: 'tls' },
        { ...base, name: 'bad15', match_ips: ['999.1.1.1.1'] },
        { ...base, name: 'bad16', caller_id_name: 'a,b' },
        { ...base, name: 'bad17', inbound_default: { type: 'dial', value: 'x' } },
        { ...base, name: 'bad18', max_channels: -1 },
        { ...base, name: 'bad19', unknown: 1 },
      ];
      for (const body of bad) {
        const res = await post('/trunks', body);
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 90));
      }
      const names = (await get('/trunks')).body.trunks.map((t) => t.name);
      assert.ok(!names.some((n) => /^bad/i.test(n)));
    });

    test('duplicate names are refused', async () => {
      assert.equal((await post('/trunks', base)).status, 409);
    });

    test('two trunks cannot accept calls from the same address (inbound calls would be ambiguous)', async () => {
      const ip = { auth_mode: 'ip', kind: 'pbx' };
      assert.equal((await post('/trunks', { ...ip, name: 'ipa', display_name: 'A', host: '10.5.5.5' })).status, 201);
      const clash = await post('/trunks', { ...ip, name: 'ipb', display_name: 'B', host: '10.5.5.5' });
      assert.equal(clash.status, 409);
      assert.equal(clash.body.error.code, 'address_in_use');
      assert.match(clash.body.error.message, /"ipa"/);
      // an extra match address counts too, in either direction
      assert.equal((await post('/trunks', { ...ip, name: 'ipc', display_name: 'C', host: '10.5.5.6', match_ips: ['10.5.5.5'] })).status, 409);
      assert.equal((await post('/trunks', { ...ip, name: 'ipd', display_name: 'D', host: '10.5.5.7' })).status, 201);
      const d = (await get('/trunks')).body.trunks.find((t) => t.name === 'ipd');
      assert.equal((await patch(`/trunks/${d.id}`, { match_ips: ['10.5.5.5'] })).status, 409, 'editing into a clash is refused too');
      assert.equal((await patch(`/trunks/${d.id}`, { host: '10.5.5.8' })).status, 200, 'a trunk does not clash with itself');
      // two accounts at one provider are told apart by their registered line, so registration trunks may share a host
      const reg = { auth_mode: 'register', host: 'sip.shared.test', username: 'u', password: 'P4ssword!' };
      assert.equal((await post('/trunks', { ...reg, name: 'rega', display_name: 'RA' })).status, 201);
      assert.equal((await post('/trunks', { ...reg, name: 'regb', display_name: 'RB', username: 'u2' })).status, 201);
      assert.equal((await post('/trunks', { ...ip, name: 'ipe', display_name: 'E', host: 'sip.shared.test' })).status, 409, 'but an IP trunk may not take a registration trunk\'s address');
      // a disabled trunk does not block its address
      const a = (await get('/trunks')).body.trunks.find((t) => t.name === 'ipa');
      await patch(`/trunks/${a.id}`, { enabled: false });
      assert.equal((await post('/trunks', { ...ip, name: 'ipf', display_name: 'F', host: '10.5.5.5' })).status, 201);
    });

    test('an IP trunk may have no credentials; a default destination must exist', async () => {
      const ok = await post('/trunks', { name: 'gw1', display_name: 'GSM gateway', kind: 'gateway', auth_mode: 'ip', host: '192.168.1.60', match_ips: ['192.168.1.60'], inbound_default: { type: 'extension', value: '1001' } });
      assert.equal(ok.status, 201);
      const ghost = await post('/trunks', { name: 'gw2', display_name: 'G2', auth_mode: 'ip', host: '192.168.1.61', inbound_default: { type: 'extension', value: '4242' } });
      assert.equal(ghost.status, 400);
    });

    test('update keeps the stored password unless a new one is given', async () => {
      const id = (await get('/trunks')).body.trunks.find((t) => t.name === 'acme').id;
      const upd = await patch(`/trunks/${id}`, { host: 'sip2.acme.test', max_channels: 4 });
      assert.equal(upd.status, 200);
      assert.equal(upd.body.trunk.host, 'sip2.acme.test');
      let row = await h.store.getTrunkRow(id);
      assert.equal(row.password, 'S3cret!pass');
      await patch(`/trunks/${id}`, { password: 'N3w-password' });
      row = await h.store.getTrunkRow(id);
      assert.equal(row.password, 'N3w-password');
      // Switching to an IP trunk does not need credentials; switching a no-credential trunk to register does.
      assert.equal((await patch(`/trunks/${id}`, { auth_mode: 'ip', username: null })).status, 200);
      assert.equal((await patch(`/trunks/${id}`, { auth_mode: 'register' })).status, 400);
    });

    test('a trunk used by a route cannot be deleted', async () => {
      const trunks = (await get('/trunks')).body.trunks;
      const gw = trunks.find((t) => t.name === 'gw1');
      const route = await post('/outbound-routes', { name: 'Out via gw', patterns: ['_9X.'], strip: 1, trunks: [gw.id] });
      assert.equal(route.status, 201);
      const res = await del(`/trunks/${gw.id}`);
      assert.equal(res.status, 409);
      assert.match(res.body.error.message, /outbound route "Out via gw"/);
    });
  });

  describe('routes', () => {
    test('inbound DID formats', async () => {
      const trunk = (await get('/trunks')).body.trunks.find((t) => t.name === 'gw1');
      const good = ['15551234567', '+15551234567', '*', '_555XXXX', '_1[2-9]XXXXXXXXX'];
      let n = 0;
      for (const did of good) {
        n += 1;
        const res = await post('/inbound-routes', { name: `ok ${n}`, did, trunk_id: trunk.id, destination: { type: 'echo' } });
        assert.equal(res.status, 201, did);
      }
      for (const did of ['', '1', 'abc', '555;1234', '_555 XXX', '555\n1234', '${EXTEN}', 'x'.repeat(30)]) {
        const res = await post('/inbound-routes', { name: 'bad', did, destination: { type: 'echo' } });
        assert.equal(res.status, 400, JSON.stringify(did));
      }
    });

    test('duplicates per trunk are refused; the same number may exist on another trunk or for all trunks', async () => {
      const trunks = (await get('/trunks')).body.trunks;
      const gw = trunks.find((t) => t.name === 'gw1');
      const acme = trunks.find((t) => t.name === 'acme');
      assert.equal((await post('/inbound-routes', { name: 'dup', did: '15551234567', trunk_id: gw.id, destination: { type: 'echo' } })).status, 409);
      assert.equal((await post('/inbound-routes', { name: 'other trunk', did: '15551234567', trunk_id: acme.id, destination: { type: 'echo' } })).status, 201);
      assert.equal((await post('/inbound-routes', { name: 'all trunks', did: '15551234567', trunk_id: null, destination: { type: 'echo' } })).status, 201);
      assert.equal((await post('/inbound-routes', { name: 'all dup', did: '15551234567', trunk_id: null, destination: { type: 'echo' } })).status, 409);
    });

    test('inbound destinations are validated', async () => {
      assert.equal((await post('/inbound-routes', { name: 'ghost', did: '5550002', destination: { type: 'extension', value: '4242' } })).status, 400);
      assert.equal((await post('/inbound-routes', { name: 'bad type', did: '5550002', destination: { type: 'shell', value: 'rm' } })).status, 400);
      assert.equal((await post('/inbound-routes', { name: 'bad hangup', did: '5550002', destination: { type: 'hangup', value: 'explode' } })).status, 400);
      assert.equal((await post('/inbound-routes', { name: 'ok hangup', did: '5550002', destination: { type: 'hangup', value: 'busy' } })).status, 201);
      assert.equal((await post('/inbound-routes', { name: 'unknown trunk', did: '5550003', trunk_id: 9999, destination: { type: 'echo' } })).status, 400);
    });

    test('outbound route validation, trunk order and updates', async () => {
      const trunks = (await get('/trunks')).body.trunks;
      const gw = trunks.find((t) => t.name === 'gw1');
      const acme = trunks.find((t) => t.name === 'acme');
      for (const body of [
        { name: 'r', patterns: [], trunks: [gw.id] },
        { name: 'r', patterns: ['_9X.'], trunks: [] },
        { name: 'r', patterns: ['_9X.;Hangup()'], trunks: [gw.id] },
        { name: 'r', patterns: ['_9X.'], trunks: [gw.id], prepend: '1;2' },
        { name: 'r', patterns: ['_9X.'], trunks: [gw.id], strip: 99 },
        { name: 'r', patterns: ['_9X.'], trunks: [9999] },
        { name: 'r', patterns: ['9X$'], trunks: [gw.id] },
      ]) {
        assert.equal((await post('/outbound-routes', body)).status, 400, JSON.stringify(body));
      }
      const made = await post('/outbound-routes', { name: 'National', patterns: ['_9NXXNXXXXXX', '_1NXXNXXXXXX'], strip: 1, prepend: '+1', trunks: [acme.id, gw.id], position: 5 });
      assert.equal(made.status, 201);
      assert.deepEqual(made.body.route.trunks.map((t) => t.name), ['acme', 'gw1'], 'trunk order is kept');
      const swapped = await patch(`/outbound-routes/${made.body.route.id}`, { trunks: [gw.id, acme.id] });
      assert.deepEqual(swapped.body.route.trunks.map((t) => t.name), ['gw1', 'acme']);
      assert.equal((await post('/outbound-routes', { name: 'National', patterns: ['_8X.'], trunks: [gw.id] })).status, 409);
    });
  });

  describe('applying configuration to Asterisk', () => {
    const files = () => ({
      pjsip: fs.readFileSync(path.join(h.generatedDir, 'pjsip_generated.conf'), 'utf8'),
      dialplan: fs.readFileSync(path.join(h.generatedDir, 'extensions_generated.conf'), 'utf8'),
    });

    test('apply writes the generated files and reloads PJSIP then the dialplan through AMI', async () => {
      assert.equal((await post('/trunks', { name: 'reg1', display_name: 'Registering', auth_mode: 'register', host: 'sip.reg.test', username: 'u1', password: 'P4ssword!' })).status, 201);
      h.ami.reset();
      const res = await post('/apply', {});
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.reloaded, true);
      const cmds = h.ami.callsFor('Command').map((c) => c.Command);
      assert.deepEqual(cmds.filter((c) => !c.startsWith('pjsip qualify')), ['module reload res_pjsip.so', 'dialplan reload']);
      assert.ok(cmds.includes('pjsip qualify trk-gw1'), 'reachability of trunks is checked straight away');      const f = files();
      assert.match(f.pjsip, /\[1001\]\(ep-webrtc\)/);
      assert.match(f.pjsip, /\[trk-gw1\]\(ep-trunk\)/);
      assert.match(f.pjsip, /\[trk-reg1\]\ntype = registration/);
      assert.ok(!f.pjsip.includes('[trk-acme]\ntype = registration'), 'acme was switched to an IP trunk');
      assert.match(f.dialplan, /\[from-trunk-gw1\]/);
      assert.match(f.dialplan, /exten => _9NXXNXXXXXX,1/);
      assert.equal(h.applier.status().inSync, true);
      assert.equal(await auditCount(h.db, "action = 'pbx.apply' AND status = 'success'"), 1);
      assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM pbx_apply_log WHERE ok')).rows[0].n) >= 1, true);
    });

    test('secrets in the generated file match the database; files are readable by Asterisk', async () => {
      const s = await h.store.getExtensionSecretsByNumber('1001');
      const f = files();
      assert.ok(f.pjsip.includes(`password = ${s.secret}`));
      assert.ok(f.pjsip.includes(`password = ${s.phone_secret}`));
      const mode = fs.statSync(path.join(h.generatedDir, 'pjsip_generated.conf')).mode & 0o777;
      assert.ok((mode & 0o044) === 0o044 || process.platform === 'win32', 'world-readable so the asterisk user can read it');
    });

    test('an unchanged configuration is not reloaded again', async () => {
      h.ami.reset();
      const res = await h.applier.apply('again');
      assert.equal(res.ok, true);
      assert.equal(res.changed, false);
      assert.equal(res.reloaded, false);
      assert.equal(h.ami.callsFor('Command').length, 0);
    });

    test('a change is applied automatically (debounced) after the API call', async () => {
      h.ami.reset();
      assert.equal((await post('/extensions', { number: '1400', display_name: 'Auto' })).status, 201);
      assert.equal((await post('/extensions', { number: '1401', display_name: 'Auto 2' })).status, 201);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(h.ami.callsFor('Command').filter((c) => c.Command === 'dialplan reload').length, 1, 'two edits, one reload');
      assert.match(files().pjsip, /\[1401\]\(ep-webrtc\)/);
    });

    test('with AMI down the files are still written and a reload follows when AMI connects', async () => {
      h.ami.reset();
      h.ami.setConnected(false);
      assert.equal((await post('/extensions', { number: '1402', display_name: 'Offline edit' })).status, 201);
      await new Promise((r) => setTimeout(r, 600));
      assert.match(files().pjsip, /\[1402\]\(ep-webrtc\)/, 'file written');
      assert.equal(h.ami.callsFor('Command').length, 0, 'nothing sent while disconnected');
      assert.equal(h.applier.status().inSync, false);
      h.ami.setConnected(true);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(h.ami.callsFor('Command').filter((c) => c.Command === 'dialplan reload').length, 1);
      assert.equal(h.applier.status().inSync, true);
    });

    test('a reload failure is reported, logged and visible in the status', async () => {
      h.ami.reset();
      h.ami.responses.set('Command', (f) => (f.Command.startsWith('module reload') ? { response: 'Success', fields: { Output: 'Module reload failed: boom' }, events: [] } : { response: 'Success', fields: {}, events: [] }));
      await post('/extensions', { number: '1403', display_name: 'Breaks' });
      await new Promise((r) => setTimeout(r, 600));
      const status = (await get('/apply')).body;
      assert.equal(status.last.ok, false);
      assert.match(status.last.error, /PJSIP reload failed/);
      assert.equal(status.inSync, false);
      h.ami.responses.clear();
      const retry = await post('/apply', {});
      assert.equal(retry.status, 200);
      assert.equal(retry.body.ok, true);
    });
  });
});
