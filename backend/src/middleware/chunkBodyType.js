/**
 * A chunk body is raw bytes, sent as application/octet-stream. Mounted ahead
 * of the JSON and urlencoded parsers: a chunk labelled as JSON or a form was
 * run through a 2mb parser and refused as 413 with a generic body (issue 2078).
 * It is refused here as 415 instead, before any byte is read. A chunk with no
 * Content-Type is refused too, as the CSRF middleware already does for any
 * untyped body.
 */
const CHUNK_PATH = /^\/[^/]+\/chunked-upload\/[^/]+\/chunk\/[^/]+\/?$/;

// adminPhotos is mounted twice: /api/admin/photos (server.js) and
// /api/admin/events (routes/admin.js). The guard has to sit on both.
const CHUNK_ROUTE_PREFIXES = ['/api/admin/photos', '/api/admin/events'];

function requireOctetStreamChunk(req, res, next) {
  if (req.method !== 'POST' || !CHUNK_PATH.test(req.path)) return next();
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/octet-stream') return next();
  return res.status(415).json({
    error: 'A chunk must be sent as application/octet-stream',
    code: 'UNSUPPORTED_MEDIA_TYPE',
  });
}

module.exports = { requireOctetStreamChunk, CHUNK_ROUTE_PREFIXES };
