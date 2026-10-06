'use strict';
const { z } = require('zod');
const { destinationSchema } = require('./destinations');

// Everything here is rendered into Asterisk configuration, where ; # $ { } " and newlines are
// special. Schemas therefore whitelist characters instead of trying to escape them.

const NUMBER_RE = /^[0-9]{3,6}$/;
const SECRET_RE = /^[A-Za-z0-9._~+=-]{12,64}$/;
const NAME_RE = /^[\p{L}\p{N} .,'&()_-]{1,40}$/u;
// Text that is placed inside dialplan Set() calls: no comma, quote, parenthesis or ampersand.
const DIALPLAN_TEXT_RE = /^[\p{L}\p{N} ._-]{1,30}$/u;
const SLUG_RE =/^[a-z][a-z0-9_-]{1,23}$/;
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3})$/;
const CIDR_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;
const SIPUSER_RE = /^[A-Za-z0-9._~+=@-]{1,64}$/;
const PHONE_RE = /^\+?[0-9]{3,20}$/;
const DID_RE = /^(?:\*|\+?[0-9]{2,20}|_[0-9XZN.!+[\]-]{1,30})$/;
const DIAL_PATTERN_RE = /^_?[0-9XZN.!+*[\]-]{1,40}$/;
const PREPEND_RE = /^\+?[0-9*]{0,20}$/;
const CODECS = ['ulaw', 'alaw', 'g722', 'gsm', 'opus', 'g729'];

const RESERVED_NUMBERS = new Set(['600']);

const numberAsString = (inner) => z.preprocess((v) => (typeof v === 'number' ? String(v) : v), inner);
const bool = z.boolean();
const nullableText = (max) => z.string().trim().max(max).nullable();

const extNumber = numberAsString(z.string().regex(NUMBER_RE, 'Number must be 3 to 6 digits'));
const displayName = z.string().trim().regex(NAME_RE, "Name may use letters, digits, spaces and . , ' & ( ) _ - (max 40)");
const secret = z.string().regex(SECRET_RE, 'Secret must be 12-64 characters from A-Z a-z 0-9 . _ ~ + = -');
const callerNumber = z.string().trim().regex(PHONE_RE, 'Use digits only (optionally starting with +)');

const createExtension = z.strictObject({
  number: extNumber,
  display_name: displayName,
  secret: secret.optional(),
  phone_secret: secret.optional(),
  webrtc_enabled: bool.optional().default(true),
  phone_enabled: bool.optional().default(true),
  allow_outbound: bool.optional().default(false),
  outbound_cid: callerNumber.nullable().optional().default(null),
  enabled: bool.optional().default(true),
  notes: nullableText(500).optional().default(null),
});

const patchExtension = z
  .strictObject({
    display_name: displayName.optional(),
    secret: secret.optional(),
    phone_secret: secret.optional(),
    webrtc_enabled: bool.optional(),
    phone_enabled: bool.optional(),
    allow_outbound: bool.optional(),
    outbound_cid: callerNumber.nullable().optional(),
    enabled: bool.optional(),
    notes: nullableText(500).optional(),
    dnd: bool.optional(),
    fwd_all: destinationSchema.nullable().optional(),
    fwd_busy: destinationSchema.nullable().optional(),
    fwd_noanswer: destinationSchema.nullable().optional(),
    noanswer_secs: z.coerce.number().int().min(5).max(120).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const groupFields = {
  name: z.string().trim().regex(NAME_RE, "Name may use letters, digits, spaces and . , ' & ( ) _ - (max 40)"),
  enabled: bool.optional(),
  members: z.array(extNumber).max(200),
};
const createPagingGroup = z.strictObject({
  number: extNumber,
  name: groupFields.name,
  enabled: bool.optional().default(true),
  members: groupFields.members,
});
const patchPagingGroup = z
  .strictObject({ name: groupFields.name.optional(), enabled: bool.optional(), members: groupFields.members.optional() })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const hostField = z.string().trim().regex(HOST_RE, 'Enter a hostname or IPv4 address');
const sipUser = z.string().trim().regex(SIPUSER_RE, 'Letters, digits and . _ ~ + = @ - only');
// Trunk passwords come from outside providers, so allow a wider set than extension secrets, but never the
// characters that are special in Asterisk configuration files.
const trunkPassword = z.string().regex(/^[A-Za-z0-9!@%^&*()_+=.,:?~-]{1,128}$/, 'Password may not contain spaces, quotes, ; # $ { } \\ < > or |');
const codecList = z.array(z.enum(CODECS)).min(1).max(6);
const ipList = z.array(z.string().trim().regex(CIDR_RE, 'Use IPv4 addresses or CIDR ranges')).max(16);

const destination = destinationSchema.nullable();

const trunkBase = {
  name: z.string().trim().regex(SLUG_RE, 'Name must be 2-24 characters: start with a letter, then a-z 0-9 _ -'),
  display_name: displayName,
  kind: z.enum(['provider', 'pbx', 'gateway']),
  auth_mode: z.enum(['register', 'ip']),
  host: hostField,
  port: z.coerce.number().int().min(1).max(65535),
  transport: z.enum(['udp', 'tcp']),
  username: sipUser.nullable(),
  password: trunkPassword.nullable(),
  auth_username: sipUser.nullable(),
  from_user: sipUser.nullable(),
  from_domain: hostField.nullable(),
  register_expiry: z.coerce.number().int().min(60).max(86400),
  codecs: codecList,
  dtmf_mode: z.enum(['rfc4733', 'inband', 'info', 'auto']),
  max_channels: z.coerce.number().int().min(0).max(500),
  caller_id_num: callerNumber.nullable(),
  caller_id_name: z.string().trim().regex(DIALPLAN_TEXT_RE, 'Letters, digits, spaces and . _ - only').nullable(),
  match_ips: ipList,
  inbound_default: destination,
  qualify: bool,
  enabled: bool,
  notes: nullableText(500),
};

const trunkRules = (o) => {
  const issues = [];
  if (o.auth_mode === 'register') {
    if (!o.username) issues.push({ path: ['username'], message: 'A registration trunk needs a username' });
    if (!o.password) issues.push({ path: ['password'], message: 'A registration trunk needs a password' });
  }
  if (o.auth_mode === 'ip' && (!o.match_ips || o.match_ips.length === 0) && !HOST_RE.test(o.host || '')) {
    issues.push({ path: ['match_ips'], message: 'An IP-authenticated trunk needs at least one address to accept calls from' });
  }
  return issues;
};

const withTrunkRules = (schema) =>
  schema.superRefine((o, ctx) => {
    for (const i of trunkRules(o)) ctx.addIssue({ code: 'custom', ...i });
  });

const createTrunk = withTrunkRules(
  z.strictObject({
    name: trunkBase.name,
    display_name: trunkBase.display_name,
    kind: trunkBase.kind.optional().default('provider'),
    auth_mode: trunkBase.auth_mode,
    host: trunkBase.host,
    port: trunkBase.port.optional().default(5060),
    transport: trunkBase.transport.optional().default('udp'),
    username: trunkBase.username.optional().default(null),
    password: trunkBase.password.optional().default(null),
    auth_username: trunkBase.auth_username.optional().default(null),
    from_user: trunkBase.from_user.optional().default(null),
    from_domain: trunkBase.from_domain.optional().default(null),
    register_expiry: trunkBase.register_expiry.optional().default(3600),
    codecs: trunkBase.codecs.optional().default(['ulaw', 'alaw']),
    dtmf_mode: trunkBase.dtmf_mode.optional().default('rfc4733'),
    max_channels: trunkBase.max_channels.optional().default(0),
    caller_id_num: trunkBase.caller_id_num.optional().default(null),
    caller_id_name: trunkBase.caller_id_name.optional().default(null),
    match_ips: trunkBase.match_ips.optional().default([]),
    inbound_default: trunkBase.inbound_default.optional().default(null),
    qualify: trunkBase.qualify.optional().default(true),
    enabled: trunkBase.enabled.optional().default(true),
    notes: trunkBase.notes.optional().default(null),
  }),
);

// `name` is the identity used in Asterisk object names and routes; it cannot be renamed.
const { name: _name, ...patchable } = trunkBase;
const patchTrunk = z
  .strictObject(Object.fromEntries(Object.entries(patchable).map(([k, v]) => [k, v.optional()])))
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const inboundRoute = {
  name: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} .,'&()_-]+$/u, "Name may use letters, digits, spaces and . , ' & ( ) _ -"),
  did: z.string().trim().regex(DID_RE, 'Use digits, +digits, an Asterisk pattern such as _555XXXX, or * for any number'),
  trunk_id: z.coerce.number().int().positive().nullable(),
  destination: destinationSchema,
  cid_name_prefix: z.string().trim().regex(DIALPLAN_TEXT_RE, 'Letters, digits, spaces and . _ - only').nullable(),
  enabled: bool,
};
const createInbound = z.strictObject({
  name: inboundRoute.name,
  did: inboundRoute.did,
  trunk_id: inboundRoute.trunk_id.optional().default(null),
  destination: inboundRoute.destination,
  cid_name_prefix: inboundRoute.cid_name_prefix.optional().default(null),
  enabled: inboundRoute.enabled.optional().default(true),
});
const patchInbound = z
  .strictObject(Object.fromEntries(Object.entries(inboundRoute).map(([k, v]) => [k, v.optional()])))
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const outboundRoute = {
  name: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} .,'&()_-]+$/u, "Name may use letters, digits, spaces and . , ' & ( ) _ -"),
  patterns: z.array(z.string().trim().regex(DIAL_PATTERN_RE, 'Use digits and the pattern characters X Z N . ! [ ] -, e.g. _9X.')).min(1).max(20),
  strip: z.coerce.number().int().min(0).max(20),
  prepend: z.string().trim().regex(PREPEND_RE, 'Digits only (optionally starting with +)'),
  cid_num: callerNumber.nullable(),
  emergency: bool,
  trunks: z.array(z.coerce.number().int().positive()).min(1).max(10),
  position: z.coerce.number().int().min(0).max(10000),
  enabled: bool,
};
const createOutbound = z.strictObject({
  name: outboundRoute.name,
  patterns: outboundRoute.patterns,
  strip: outboundRoute.strip.optional().default(0),
  prepend: outboundRoute.prepend.optional().default(''),
  cid_num: outboundRoute.cid_num.optional().default(null),
  emergency: outboundRoute.emergency.optional().default(false),
  trunks: outboundRoute.trunks,
  position: outboundRoute.position.optional().default(0),
  enabled: outboundRoute.enabled.optional().default(true),
});
const patchOutbound = z
  .strictObject(Object.fromEntries(Object.entries(outboundRoute).map(([k, v]) => [k, v.optional()])))
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const ringGroupFields = {
  name: z.string().trim().regex(NAME_RE, "Name may use letters, digits, spaces and . , ' & ( ) _ - (max 40)"),
  strategy: z.enum(['ringall', 'sequential']),
  ring_secs: z.coerce.number().int().min(5).max(120),
  members: z.array(extNumber).min(1, 'Add at least one member').max(50),
  fail_dest: destination,
  enabled: bool,
};
const createRingGroup = z.strictObject({
  number: extNumber,
  name: ringGroupFields.name,
  strategy: ringGroupFields.strategy.optional().default('ringall'),
  ring_secs: ringGroupFields.ring_secs.optional().default(20),
  members: ringGroupFields.members,
  fail_dest: ringGroupFields.fail_dest.optional().default(null),
  enabled: ringGroupFields.enabled.optional().default(true),
});
const patchRingGroup = z
  .strictObject(Object.fromEntries(Object.entries(ringGroupFields).map(([k, v]) => [k, v.optional()])))
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeZone = z.string().trim().max(40).regex(/^[A-Za-z]+(?:[/_+-][A-Za-z0-9_+-]+)*$/, 'Not a valid time zone name')
  .refine((tz) => {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
  }, 'Unknown time zone (use a name such as America/New_York or UTC)');
const timeRule = z.strictObject({
  days: z.array(z.enum(DAYS)).min(1, 'Choose at least one day').max(7),
  from: z.string().regex(HHMM, 'Use HH:MM'),
  to: z.string().regex(HHMM, 'Use HH:MM'),
}).refine((r) => r.from !== r.to, { message: 'Start and end must differ', path: ['to'] });
const holiday = z.strictObject({
  month: z.coerce.number().int().min(1).max(12),
  day: z.coerce.number().int().min(1).max(31),
  name: z.string().trim().regex(DIALPLAN_TEXT_RE, 'Letters, digits, spaces and . _ - only').optional().default(''),
});
const timeConditionFields = {
  name: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} .,'&()_-]+$/u, "Name may use letters, digits, spaces and . , ' & ( ) _ -"),
  timezone: timeZone,
  rules: z.array(timeRule).max(40),
  holidays: z.array(holiday).max(100),
  match_dest: destinationSchema,
  nomatch_dest: destinationSchema,
  override: z.enum(['auto', 'open', 'closed']),
  enabled: bool,
};
const createTimeCondition = z.strictObject({
  name: timeConditionFields.name,
  timezone: timeConditionFields.timezone.optional().default('UTC'),
  rules: timeConditionFields.rules,
  holidays: timeConditionFields.holidays.optional().default([]),
  match_dest: timeConditionFields.match_dest,
  nomatch_dest: timeConditionFields.nomatch_dest,
  override: timeConditionFields.override.optional().default('auto'),
  enabled: timeConditionFields.enabled.optional().default(true),
});
const patchTimeCondition = z
  .strictObject(Object.fromEntries(Object.entries(timeConditionFields).map(([k, v]) => [k, v.optional()])))
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const idParam = z.strictObject({ id: z.coerce.number().int().positive() });

const cdrQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(50),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  number: z.string().trim().min(1).max(40).regex(/^[0-9A-Za-z*#+._@-]+$/).optional(),
  src: z.string().trim().min(1).max(40).regex(/^[0-9A-Za-z*#+._@-]+$/).optional(),
  dst: z.string().trim().min(1).max(40).regex(/^[0-9A-Za-z*#+._@-]+$/).optional(),
  direction: z.enum(['internal', 'inbound', 'outbound']).optional(),
  disposition: z.enum(['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED', 'CONGESTION']).optional(),
  trunk: z.string().trim().regex(SLUG_RE).optional(),
  minDuration: z.coerce.number().int().min(0).max(86400).optional(),
  legs: z.enum(['all', 'calls']).optional().default('calls'),
});
const cdrStatsQuery = z.strictObject({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

module.exports = {
  RESERVED_NUMBERS,
  CODECS,
  schemas: {
    createExtension, patchExtension, createPagingGroup, patchPagingGroup,
    createTrunk, patchTrunk, createInbound, patchInbound, createOutbound, patchOutbound,
    createRingGroup, patchRingGroup, createTimeCondition, patchTimeCondition,
    idParam, cdrQuery, cdrStatsQuery,
  },
  trunkRules,
};
