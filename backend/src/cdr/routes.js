'use strict';
const express = require('express');
const { schemas } = require('../pbx/schemas');
const { validate } = require('../validation/middleware');
const { clientIp } = require('../auth/middleware');

const CSV_COLUMNS = ['start_time', 'answer_time', 'end_time', 'src', 'dst', 'caller_id', 'direction', 'trunk', 'disposition', 'duration', 'billsec', 'channel', 'dst_channel'];

// A CSV cell that starts with = + - @ is executed as a formula by spreadsheet software; neutralise it.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Mounted at /cdr behind authenticate + requireRole('admin'). */
function cdrRoutes({ cdr, audit }) {
  const router = express.Router();

  router.get('/', validate({ query: schemas.cdrQuery }), async (req, res) => {
    res.json(await cdr.list(req.valid.query));
  });

  router.get('/stats', validate({ query: schemas.cdrStatsQuery }), async (req, res) => {
    res.json(await cdr.stats(req.valid.query));
  });

  router.get('/export.csv', validate({ query: schemas.cdrQuery }), async (req, res) => {
    const rows = await cdr.exportRows(req.valid.query);
    await audit.log({ user: req.user, action: 'cdr.export', target: 'csv', ip: clientIp(req), details: { rows: rows.length } });
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="call-history.csv"', 'Cache-Control': 'no-store' });
    res.send(`${lines.join('\r\n')}\r\n`);
  });

  return router;
}

module.exports = { cdrRoutes, csvCell };
