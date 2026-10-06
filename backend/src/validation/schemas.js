'use strict';
const { z } = require('zod');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const ROLES = ['admin', 'operator', 'user'];

const username = z.string().trim().toLowerCase().regex(USERNAME_RE, 'Username must be 3-32 characters: a-z, 0-9, dot, underscore or hyphen');
const password = z.string().min(12, 'Password must be at least 12 characters').max(128, 'Password must be at most 128 characters');
const role = z.enum(ROLES);
// Format only: whether the extension exists is checked against the live registry by the callers.
const extension = z.string().regex(/^[0-9]{3,6}$/, 'Extension must be 3 to 6 digits');
const extensionOrNull = extension.nullable();

// Accept 700 or "700" but nothing else.
const numberAsString = (inner) => z.preprocess((v) => (typeof v === 'number' ? String(v) : v), inner);

const login = z.strictObject({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

const createUser = z.strictObject({
  username,
  password,
  role,
  extension: extensionOrNull.optional().default(null),
  is_active: z.boolean().optional().default(true),
});

const patchUser = z
  .strictObject({
    role: role.optional(),
    is_active: z.boolean().optional(),
    extension: extensionOrNull.optional(),
    password: password.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

const idParam = z.strictObject({ id: z.coerce.number().int().positive() });

const originate = z
  .strictObject({ from: numberAsString(extension), to: numberAsString(extension) })
  .refine((o) => o.from !== o.to, { message: 'from and to must be different extensions', path: ['to'] });

const hangup = z.strictObject({ extension: numberAsString(extension) });

const page = z.strictObject({ group: numberAsString(z.string().regex(/^[0-9]{3,6}$/, 'Group must be 3 to 6 digits')) });

const auditQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  action: z.string().min(1).max(64).optional(),
  username: z.string().min(1).max(64).optional(),
  status: z.enum(['success', 'failure']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// A deliberately small deny-list on top of the length rule.
const COMMON_PASSWORDS = new Set(['password1234', '123456789012', 'qwertyuiop12', 'administrator', 'changemechangeme']);

function passwordPolicyError(pw, name) {
  if (COMMON_PASSWORDS.has(String(pw).toLowerCase())) return 'Password is too common';
  if (/^(.)\1+$/.test(pw)) return 'Password must not be a single repeated character';
  if (name && String(pw).toLowerCase().includes(String(name).toLowerCase())) return 'Password must not contain the username';
  return null;
}

module.exports = {
  ROLES,
  USERNAME_RE,
  schemas: { login, createUser, patchUser, idParam, originate, hangup, page, auditQuery },
  password,
  passwordPolicyError,
};
