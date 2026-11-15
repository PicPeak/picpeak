/**
 * A response held back until `flush()`.
 *
 * A chunked upload's complete step answers only once its admission has
 * settled in `finally`, as withPublicUpload does for a multipart upload: the
 * page starts the next file on this answer, and that file needs the slot.
 * Handlers write to the reply as to `res` (set / status / json).
 */
function deferredReply(res) {
  let body;
  let status = 200;
  const reply = {
    set(name, value) { res.set(name, value); return reply; },
    status(code) { status = code; return reply; },
    json(value) { body = value; return reply; },
    flush() {
      if (body !== undefined && !res.headersSent && !res.destroyed) res.status(status).json(body);
    },
  };
  return reply;
}

module.exports = { deferredReply };
