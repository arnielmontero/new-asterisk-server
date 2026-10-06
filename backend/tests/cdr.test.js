'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { csvCell } = require('../src/cdr/routes');
const { parseAstTime } = require('../src/cdr/service');

let seq = 0;
const cdrEvent = (over = {}) => {
  seq += 1;
  return {
    Event: 'Cdr', AccountCode: '', Source: '1001', Destination: '1002', DestinationContext: 'default', CallerID: '"Office" <1001>',
    Channel: `PJSIP/1001-0000000${seq}`, DestinationChannel: `PJSIP/1002-0000000${seq}`, LastApplication: 'Dial', LastData: 'PJSIP/1002,30',
    StartTime: '2026-10-05 10:00:00', AnswerTime: '2026-10-05 10:00:05', EndTime: '2026-10-05 10:01:05', Duration: '65', BillableSeconds: '60',
    Disposition: 'ANSWERED', AMAFlags: 'DOCUMENTATION', UniqueID: `1791000000.${seq}`, UserField: '', ...over,
  };
};

describe('call detail records', () => {
  let h; let admin; let operator;
  before(async () => {
    h = await createHarness();
    admin = await h.seedAdmin();
    operator = await h.makeUser({ username: 'op.cdr', role: 'operator', extension: '1001' });
    h.registry.load({
      extensions: [{ number: '1001', display_name: 'Office', enabled: true }, { number: '1002', display_name: 'Warehouse', enabled: true }],
      groups: [], trunks: [{ id: 1, name: 'acme', display_name: 'Acme', auth_mode: 'register', host: 'x', enabled: true }],
    });
  });
  after(async () => h.cleanup());

  const ingest = (over) => h.cdr.ingest(cdrEvent(over));
  const list = (qs = '', who = admin) => h.agent().get(`/api/cdr${qs}`).set(who.auth);

  test('Asterisk timestamps are parsed as UTC; blanks are null', () => {
    assert.equal(parseAstTime('2026-10-05 10:00:00').toISOString(), '2026-10-05T10:00:00.000Z');
    assert.equal(parseAstTime(''), null);
    assert.equal(parseAstTime('garbage'), null);
  });

  test('a Cdr AMI event is stored and the direction is derived from the channels', async () => {
    h.ami.emit('event', cdrEvent());
    await new Promise((r) => setTimeout(r, 100));
    await ingest({ Source: '15557778888', Destination: 'h', Channel: 'PJSIP/trk-acme-00000009', DestinationChannel: '', UserField: 'in:15551230000', LastApplication: 'NoOp' });
    await ingest({ Source: '1001', Destination: '95551234', DestinationChannel: 'PJSIP/trk-acme-0000000a' });
    const rows = (await list('?legs=all')).body.items;
    const byDir = Object.fromEntries(rows.map((r) => [r.direction, r]));
    assert.equal(byDir.internal.dst, '1002');
    assert.equal(byDir.inbound.trunk, 'acme');
    assert.equal(byDir.inbound.dst, '15551230000', 'the dialled number replaces Asterisk\'s "h"');
    assert.equal(byDir.outbound.trunk, 'acme');
    assert.equal(byDir.internal.billsec, 60);
    assert.equal(byDir.internal.disposition, 'ANSWERED');
  });

  test('duplicate events do not create duplicate rows; events without a start time are ignored', async () => {
    const e = cdrEvent({ UniqueID: 'dup.1', DestinationChannel: 'PJSIP/1002-dup' });
    await h.cdr.ingest(e);
    await h.cdr.ingest(e);
    assert.equal((await list('?legs=all&number=dup')).body.total, 0, 'number filter does not match unique ids');
    const rows = (await h.db.query("SELECT count(*) AS n FROM cdr WHERE unique_id = 'dup.1'")).rows[0].n;
    assert.equal(rows, '1');
    assert.equal(await h.cdr.ingest(cdrEvent({ StartTime: '' })), null);
    assert.equal(await h.cdr.ingest({ Event: 'Cdr' }), null);
  });

  test('the calls view hides Local channel plumbing and cancelled legs of answered calls', async () => {
    const uid = 'multi.1';
    await h.cdr.ingest(cdrEvent({ UniqueID: uid, Source: '2001', Destination: '2002', Channel: 'PJSIP/2001-aa', DestinationChannel: 'PJSIP/2002-aa', Disposition: 'ANSWERED' }));
    await h.cdr.ingest(cdrEvent({ UniqueID: uid, Source: '2001', Destination: '2002', Channel: 'PJSIP/2001-aa', DestinationChannel: 'PJSIP/2002-phone-aa', Disposition: 'NO ANSWER', BillableSeconds: '0' }));
    await h.cdr.ingest(cdrEvent({ UniqueID: 'local.1', Source: '2001', Destination: '2002', Channel: 'Local/2002@default-00000001;1', DestinationChannel: '' }));
    await h.cdr.ingest(cdrEvent({ UniqueID: 'missed.1', Source: '2003', Destination: '2004', Channel: 'PJSIP/2003-bb', DestinationChannel: 'PJSIP/2004-bb', Disposition: 'NO ANSWER', BillableSeconds: '0' }));
    const calls = (await list('?number=200')).body.items;
    assert.deepEqual(calls.map((r) => `${r.src}>${r.dst}:${r.disposition}`).sort(), ['2001>2002:ANSWERED', '2003>2004:NO ANSWER']);
    const all = (await list('?number=200&legs=all')).body.items;
    assert.equal(all.length, 4);
  });

  test('filters: number, direction, disposition, trunk, duration and date range; paging', async () => {
    assert.ok((await list('?direction=outbound')).body.items.every((r) => r.direction === 'outbound'));
    assert.ok((await list('?trunk=acme')).body.items.every((r) => r.trunk === 'acme'));
    assert.ok((await list('?disposition=NO%20ANSWER')).body.items.every((r) => r.disposition === 'NO ANSWER'));
    assert.ok((await list('?minDuration=61')).body.items.length === 0);
    assert.ok((await list('?minDuration=60')).body.items.length > 0);
    assert.equal((await list('?from=2030-01-01T00:00:00Z')).body.total, 0);
    assert.ok((await list('?from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z')).body.total > 0);
    const page1 = (await list('?pageSize=2&page=1')).body;
    const page2 = (await list('?pageSize=2&page=2')).body;
    assert.equal(page1.items.length, 2);
    assert.ok(page1.total > 2);
    assert.notEqual(page1.items[0].id, page2.items[0].id);
  });

  test('filter input is validated (and SQL injection attempts do nothing)', async () => {
    for (const qs of ['?pageSize=9999', '?page=0', "?number=1' OR '1'='1", '?direction=sideways', '?disposition=MAYBE', '?trunk=Bad%20Name', '?from=notadate', '?extra=1', '?legs=everything']) {
      assert.equal((await list(qs)).status, 400, qs);
    }
    assert.equal((await h.db.query('SELECT count(*) AS n FROM cdr')).rows.length, 1, 'table still exists');
  });

  test('statistics summarise the filtered calls', async () => {
    const s = (await h.agent().get('/api/cdr/stats').set(admin.auth)).body;
    assert.ok(s.summary.total >= 4);
    assert.ok(s.summary.answered >= 3);
    assert.equal(s.summary.total, s.summary.answered + s.summary.missed);
    assert.ok(s.byDirection.some((d) => d.direction === 'internal'));
    assert.ok(Array.isArray(s.perDay) && Array.isArray(s.perHour));
    assert.ok(s.topSources.length > 0 && s.topDestinations.length > 0);
    const empty = (await h.agent().get('/api/cdr/stats?from=2031-01-01T00:00:00Z').set(admin.auth)).body;
    assert.equal(empty.summary.total, 0);
  });

  test('CSV export: header, rows, audited, and spreadsheet formulas are neutralised', async () => {
    await h.cdr.ingest(cdrEvent({ UniqueID: 'csv.1', Source: '=HYPERLINK("http://evil")', Destination: '+1555', Channel: 'PJSIP/9-csv', DestinationChannel: 'PJSIP/8-csv' }));
    assert.equal((await h.agent().get('/api/cdr/export.csv?number=%3DHYPERLINK%28').set(admin.auth)).status, 400, 'the number filter does not allow quotes or parentheses');
    const ok = await h.agent().get('/api/cdr/export.csv?direction=internal').set(admin.auth);
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /text\/csv/);
    assert.match(ok.headers['content-disposition'], /attachment/);
    const lines = ok.text.trim().split('\r\n');
    assert.equal(lines[0], 'start_time,answer_time,end_time,src,dst,caller_id,direction,trunk,disposition,duration,billsec,channel,dst_channel');
    assert.ok(lines.length > 2);
    assert.ok(ok.text.includes("'=HYPERLINK(\"\"http://evil\"\")") || ok.text.includes("\"'=HYPERLINK(\"\"http://evil\"\")\""), 'formula prefix neutralised');
    assert.ok(!/(^|,)=HYPERLINK/m.test(ok.text));
    const audit = await h.db.query("SELECT count(*) AS n FROM audit_logs WHERE action = 'cdr.export'");
    assert.equal(audit.rows[0].n, '1');
  });

  test('csvCell quotes and neutralises', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('-5'), "'-5");
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(new Date('2026-10-05T10:00:00Z')), '2026-10-05T10:00:00.000Z');
  });

  test('only administrators can read call records', async () => {
    assert.equal((await list('', operator)).status, 403);
    assert.equal((await h.agent().get('/api/cdr')).status, 401);
    assert.equal((await h.agent().get('/api/cdr/stats').set(operator.auth)).status, 403);
    assert.equal((await h.agent().get('/api/cdr/export.csv').set(operator.auth)).status, 403);
  });

  test('retention pruning removes only old records', async () => {
    await h.cdr.ingest(cdrEvent({ UniqueID: 'old.1', StartTime: '2020-01-01 00:00:00', AnswerTime: '', EndTime: '2020-01-01 00:00:10', DestinationChannel: 'PJSIP/old' }));
    const before = Number((await h.db.query('SELECT count(*) AS n FROM cdr')).rows[0].n);
    const removed = await h.cdr.prune(365);
    assert.ok(removed >= 1);
    assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM cdr')).rows[0].n), before - removed);
    assert.equal((await h.db.query("SELECT count(*) AS n FROM cdr WHERE unique_id = 'old.1'")).rows[0].n, '0');
  });
});

describe('trunk status', () => {
  let h;
  before(async () => {
    h = await createHarness();
    h.registry.load({
      extensions: [], groups: [],
      trunks: [
        { id: 1, name: 'acme', display_name: 'Acme', auth_mode: 'register', host: 'x', enabled: true },
        { id: 2, name: 'gw', display_name: 'GW', auth_mode: 'ip', host: 'y', enabled: true },
        { id: 3, name: 'off', display_name: 'Off', auth_mode: 'ip', host: 'z', enabled: false },
      ],
    });
  });
  after(async () => h.cleanup());

  const state = (name) => h.trunkStatus.snapshot().find((t) => t.name === name);

  test('registration, reachability and channel counts come from real AMI data', async () => {
    h.ami.responses.set('PJSIPShowRegistrationsOutbound', { response: 'Success', fields: {}, events: [{ Event: 'OutboundRegistrationDetail', ObjectName: 'trk-acme', Status: 'Registered' }] });
    h.ami.responses.set('PJSIPShowContacts', { response: 'Success', fields: {}, events: [{ Event: 'ContactList', EndpointName: 'trk-gw', Status: 'Unreachable' }] });
    h.ami.responses.set('CoreShowChannels', { response: 'Success', fields: {}, events: [{ Event: 'CoreShowChannel', Channel: 'PJSIP/trk-acme-0000000a' }, { Event: 'CoreShowChannel', Channel: 'PJSIP/1001-0000000b' }] });
    await h.trunkStatus.refresh();
    assert.equal(state('acme').state, 'online');
    assert.equal(state('acme').activeChannels, 1);
    assert.equal(state('gw').state, 'offline');
    assert.equal(state('off').state, 'disabled');
  });

  test('a rejected registration says why; events update reachability live', async () => {
    h.ami.responses.set('PJSIPShowRegistrationsOutbound', { response: 'Success', fields: {}, events: [{ Event: 'OutboundRegistrationDetail', ObjectName: 'trk-acme', Status: 'Rejected' }] });
    await h.trunkStatus.refresh();
    assert.equal(state('acme').state, 'offline');
    assert.match(state('acme').detail, /rejected/i);
    const seen = [];
    h.trunkStatus.on('change', (s) => seen.push(s));
    h.ami.emit('event', { Event: 'ContactStatus', EndpointName: 'trk-gw', ContactStatus: 'Reachable' });
    assert.equal(state('gw').state, 'online');
    assert.equal(seen.length, 1);
  });

  test('nothing is guessed while AMI is down', async () => {
    h.ami.setConnected(false);
    assert.equal(state('acme').state, 'unknown');
    assert.equal(state('gw').state, 'unknown');
    assert.equal(state('off').state, 'disabled');
    h.ami.setConnected(true);
  });
});
