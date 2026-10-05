'use strict';
const { badRequest } = require('../errors');

/**
 * Validate req.body / req.query / req.params against zod schemas. Parsed values
 * are placed on req.valid; unknown fields are rejected by the (strict) schemas.
 * Error details contain field paths and messages only, never submitted values.
 */
function validate({ body, query, params }) {
  return (req, _res, next) => {
    req.valid = {};
    const parts = { body, query, params };
    for (const [key, schema] of Object.entries(parts)) {
      if (!schema) continue;
      const source = key === 'body' ? req.body ?? {} : req[key];
      const result = schema.safeParse(source);
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({ field: i.path.join('.') || key, message: i.message }));
        return next(badRequest('Invalid request', 'validation_error', issues));
      }
      req.valid[key] = result.data;
    }
    return next();
  };
}

module.exports = { validate };
