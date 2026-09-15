const crypto = require('crypto');

// A request id ties a failed request, its error response and its log lines
// together without showing the user anything sensitive (issue 1447): an admin
// can quote the id from an error message, and the same id is in the server log.
//
// An inbound X-Request-Id is kept only when it looks like an id, so a reverse
// proxy's correlation id survives end to end but a client cannot write
// arbitrary text into the logs through it.
const INBOUND_ID = /^[A-Za-z0-9._-]{8,128}$/;

module.exports = function requestId(req, res, next) {
  const inbound = req.headers['x-request-id'];
  req.id = typeof inbound === 'string' && INBOUND_ID.test(inbound) ? inbound : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
