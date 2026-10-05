'use strict';

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, code = 'bad_request', details) => new HttpError(400, code, msg, details);
const unauthorized = (msg = 'Authentication required', code = 'unauthorized') => new HttpError(401, code, msg);
const forbidden = (msg = 'You do not have permission to do this', code = 'forbidden') => new HttpError(403, code, msg);
const notFound = (msg = 'Not found', code = 'not_found') => new HttpError(404, code, msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
