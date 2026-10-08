const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const quota = require('../services/publicUploadQuota');
const { rateLimitKey } = require('../utils/rateLimitKey');
const logger = require('../utils/logger');

// After a mid-body refusal, this much more of the request is read and thrown
// away (never staged) so the refusal is not lost to a connection reset.
const DRAIN_BYTES = 1024 * 1024;
const DRAIN_MS = 2000;

/** Wrap Multer, not just its storage engine: skipped files, unknown parts and
 * multipart framing consume the same raw byte budget. Content-Length only
 * sizes the reservation; the stream is metered against it regardless.
 * The factory receives guarded storage/stream options and the admitted count. */
async function withPublicUpload(req, res, scope, makeUploader, handler) {
  let session;
  const writers = new Set();
  let timer;
  let guard;
  let parser;
  let stopped = false;
  let response;
  let responseStatus = 200;
  let phase = 'admission';
  // Normal responses wait for staging cleanup/reservation settlement. Only a
  // streaming refusal bypasses this buffer so an infinite body is cut off now.
  const reply = {
    get headersSent() { return res.headersSent; },
    status(code) { responseStatus = code; return reply; },
    json(body) { response = body; return reply; },
  };
  const failStream = err => {
    if (stopped) return;
    stopped = true;
    req.unpipe(guard);
    req.pause();
    if (parser && !parser.destroyed) parser.destroy(err);
    if (guard && !guard.destroyed) guard.destroy();
    if (res.headersSent || res.destroyed) { req.destroy(); return; }
    res.status(err.status || 400).json({ error: err.message, code: err.code || 'UPLOAD_REJECTED' });
    // Closing a socket that still has unread request bytes resets it, and the
    // reset can discard the refusal before the client reads it (which is also
    // what `Connection: close` makes Node do as soon as the response is
    // flushed). Discard a bounded remainder first, then close; never drain an
    // attacker-controlled infinite body. A request that declared its length
    // was already refused at admission, before any of its body was read.
    let drained = 0;
    const close = () => { clearTimeout(drainTimer); req.destroy(); };
    const drainTimer = setTimeout(close, DRAIN_MS);
    drainTimer.unref();
    req.on('data', chunk => { drained += chunk.length; if (drained > DRAIN_BYTES) close(); });
    req.once('end', () => clearTimeout(drainTimer));
    req.resume();
  };
  try {
    await quota.cleanupAbandoned();
    const length = req.headers['transfer-encoding'] ? NaN : Number(req.headers['content-length']);
    session = await quota.begin({
      ...scope, clientKey: rateLimitKey(req), declaredBytes: Number.isSafeInteger(length) && length >= 0 ? length : null,
    });
    session.isCancelled = () => Boolean(req.aborted || res.destroyed);
    if (req.destroyed || session.isCancelled()) throw quota.refusal('UPLOAD_CANCELLED', 400);
    phase = 'staging';
    req.publicUploadReservation = session;
    const storage = {
      _handleFile(_req, file, cb) {
        const filename = crypto.randomUUID();
        const filePath = path.join(session.dir, filename);
        file.path = filePath; // Multer's cancellation cleanup can find it too.
        let size = 0;
        const meter = new Transform({ transform(chunk, _encoding, next) { size += chunk.length; next(null, chunk); } });
        // Each file part past the first claims its own slot before staging.
        const writer = quota.reserveFile(session)
          .then(() => pipeline(file.stream, meter, fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 })));
        writers.add(writer);
        writer.then(() => cb(null, { destination: session.dir, filename, path: filePath, size }), err => cb(err))
          .finally(() => writers.delete(writer));
      },
      _removeFile(_req, file, cb) {
        if (!file.path || path.dirname(file.path) !== session.dir) return cb(new Error('Invalid staged upload path'));
        fs.unlink(file.path, err => cb(err && err.code !== 'ENOENT' ? err : null));
      },
    };
    const streamHandler = (_req, busboy) => {
      parser = busboy;
      guard = new Transform({
        transform(chunk, _encoding, next) {
          session.receivedBytes += chunk.length;
          if (session.receivedBytes > session.bytes) {
            next(quota.refusal('UPLOAD_REQUEST_TOO_LARGE', 413));
          } else next(null, chunk);
        },
      });
      guard.on('error', failStream);
      guard.pipe(busboy);
      req.pipe(guard);
      timer = setTimeout(() => failStream(quota.refusal('UPLOAD_TIMEOUT', 408)), session.limits.requestTimeoutMs);
      timer.unref();
    };
    const uploader = makeUploader({ storage, streamHandler, maxFiles: session.maxFiles });
    await new Promise((resolve, reject) => uploader(req, res, err => err ? reject(err) : resolve()));
    clearTimeout(timer);
    if (guard) req.unpipe(guard);
    phase = 'handling';
    if (session.isCancelled()) throw quota.refusal('UPLOAD_CANCELLED', 400);
    await handler(session, reply);
  } catch (err) {
    if (!res.headersSent && !res.destroyed) {
      // Public callers never receive filesystem paths or adapter errors.
      const publicError = err.status && /^UPLOAD_/.test(err.code || '');
      res.status(publicError ? err.status : phase === 'staging' ? 400 : phase === 'handling' ? 500 : 503).json({
        // Multer's own limit messages and a route's validation refusals
        // (`expose`) are fixed, safe strings; anything else stays generic.
        error: publicError ? err.message : err.code === 'LIMIT_FILE_SIZE' ? scope.fileLimitMessage || 'File exceeds the configured size limit.'
          : err.name === 'MulterError' || err.expose === true ? err.message : 'Upload failed',
        code: publicError ? err.code : phase === 'admission' ? 'UPLOAD_QUOTA_UNAVAILABLE' : 'UPLOAD_REJECTED',
      });
    }
    logger.warn('Public upload rejected', { code: err.code, error: err.message });
  } finally {
    clearTimeout(timer);
    if (guard) { req.unpipe(guard); guard.destroy(); }
    // Multer may callback on client close before an engine finishes. Wait for
    // the actual writes before removing the owned directory or freeing quota.
    await Promise.allSettled([...writers]);
    if (session) {
      try { await quota.finish(session); } catch (err) {
        logger.warn('Public upload settlement failed; reservation retained', { requestId: session.id, error: err.message });
      }
    }
    delete req.publicUploadReservation;
    if (response !== undefined && !res.headersSent && !res.destroyed) res.status(responseStatus).json(response);
  }
}

module.exports = { withPublicUpload };
