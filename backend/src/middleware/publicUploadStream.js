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
  let countBody;
  let stopped = false;
  const cancellation = new AbortController();
  const cancelImageWork = () => cancellation.abort();
  req.once('aborted', cancelImageWork);
  res.once('close', cancelImageWork);
  let response;
  let responseStatus = 200;
  let phase = 'admission';
  // Normal responses wait for staging cleanup/reservation settlement. Only a
  // streaming refusal bypasses this buffer so an infinite body is cut off now.
  const reply = {
    get headersSent() { return res.headersSent; },
    get locals() { return res.locals; },
    get req() { return res.req; },
    set(name, value) { res.set(name, value); return reply; },
    status(code) { responseStatus = code; return reply; },
    json(body) { response = body; return reply; },
  };
  const failStream = err => {
    if (stopped) return;
    stopped = true;
    cancellation.abort();
    if (scope.mode === 'admin') quota.forAdmin(err);
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
  // Multer drains a rejected body to avoid EPIPE. Keep that drain inside our
  // raw byte/deadline budget, with no further parsing, file writes or buffering
  // behind a parser that has stopped consuming. An infinite body is still cut
  // off by failStream rather than drained without a bound.
  const discardBody = err => {
    if (guard) { guard.unpipe(parser); guard.resume(); }
    if (err && parser && !parser.destroyed) {
      const currentParser = parser;
      // Busboy emits limits synchronously inside its write callback. Destroy
      // only after that callback returns, or its current-file state is nulled
      // while Busboy is still updating the truncated file.
      queueMicrotask(() => { if (!currentParser.destroyed) currentParser.destroy(err); });
    }
  };
  try {
    await quota.cleanupAbandoned();
    const length = req.headers['transfer-encoding'] ? NaN : Number(req.headers['content-length']);
    session = await quota.begin({
      ...scope, clientKey: rateLimitKey(req), declaredBytes: Number.isSafeInteger(length) && length >= 0 ? length : null,
    });
    session.isCancelled = () => Boolean(stopped || req.aborted || res.destroyed);
    session.signal = cancellation.signal;
    if (req.destroyed || session.isCancelled()) throw quota.refusal('UPLOAD_CANCELLED', 400);
    phase = 'staging';
    req.publicUploadReservation = session;
    const storage = {
      _handleFile(_req, file, cb) {
        // A private caller's validated extension preserves existing content
        // validation; never use an untrusted basename as a staging path.
        const extension = scope.fileExtension?.(file) || '';
        if (extension && !/^\.[a-z0-9]{1,10}$/i.test(extension)) {
          const error = new Error('Invalid upload extension');
          discardBody(error); return cb(error);
        }
        const filename = crypto.randomUUID() + extension;
        const filePath = path.join(session.dir, filename);
        file.path = filePath; // Multer's cancellation cleanup can find it too.
        let size = 0;
        const meter = new Transform({ transform(chunk, _encoding, next) { size += chunk.length; next(null, chunk); } });
        const fileGuard = scope.fileGuard?.(file);
        if (fileGuard) fileGuard.on('error', discardBody);
        // Each file part past the first claims its own slot before staging.
        const writer = quota.reserveFile(session)
          .then(() => pipeline(file.stream, ...(fileGuard ? [fileGuard] : []), meter, fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 })));
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
          if (stopped) next(quota.refusal('UPLOAD_CANCELLED', 400));
          else next(null, chunk);
        },
      });
      // Count at the request inlet too: Multer's error-drain reads directly
      // from req, and must not bypass metering if parser backpressure stops
      // Transform callbacks. This listener precedes the pipe's data listener.
      countBody = chunk => {
        session.receivedBytes += chunk.length;
        if (session.receivedBytes > session.bytes) failStream(quota.refusal('UPLOAD_REQUEST_TOO_LARGE', 413));
      };
      req.on('data', countBody);
      busboy.on('error', () => discardBody());
      for (const event of ['partsLimit', 'filesLimit', 'fieldsLimit']) {
        busboy.on(event, () => discardBody(new Error('Multipart limit exceeded')));
      }
      busboy.on('file', (field, stream) => {
        // Multer's .array/.single wrapper can reject an unexpected field
        // before our fileFilter runs. Discard it without retaining a parser
        // queue behind a file stream that nobody is consuming.
        if (scope.fileField && field !== scope.fileField) discardBody(new Error('Unexpected upload field'));
        stream.on('limit', () => discardBody(new Error('File size limit exceeded')));
      });
      guard.on('error', failStream);
      guard.pipe(busboy);
      req.pipe(guard);
      timer = setTimeout(() => failStream(quota.refusal('UPLOAD_TIMEOUT', 408)), session.limits.requestTimeoutMs);
      timer.unref();
    };
    if (!req.is('multipart/form-data')) {
      throw Object.assign(new Error('Expected a multipart/form-data upload.'), { status: 400, code: 'UPLOAD_REJECTED' });
    }
    const uploader = makeUploader({ storage, streamHandler, maxFiles: session.maxFiles, rejectBody: discardBody });
    await new Promise((resolve, reject) => uploader(req, res, err => err ? reject(err) : resolve()));
    clearTimeout(timer);
    if (countBody) req.removeListener('data', countBody);
    if (guard) req.unpipe(guard);
    phase = 'handling';
    if (session.isCancelled()) throw quota.refusal('UPLOAD_CANCELLED', 400);
    await Promise.all([...writers]);
    await handler(session, reply);
  } catch (err) {
    if (scope.mode === 'admin') quota.forAdmin(err);
    if (!res.headersSent && !res.destroyed) {
      // Public callers never receive filesystem paths or adapter errors.
      const publicError = err.status && /^UPLOAD_/.test(err.code || '');
      const formatted = !publicError && phase === 'staging' ? scope.formatError?.(err) : null;
      const status = formatted?.status || (publicError ? err.status : phase === 'staging' ? 400 : phase === 'handling' ? 500 : 503);
      const body = formatted?.body || {
        // Multer's own limit messages and a route's validation refusals
        // (`expose`) are fixed, safe strings; anything else stays generic.
        error: publicError ? err.message : err.code === 'LIMIT_FILE_SIZE' ? scope.fileLimitMessage || 'File exceeds the configured size limit.'
          : err.name === 'MulterError' || err.expose === true ? err.message : 'Upload failed',
        code: publicError ? err.code : phase === 'admission' ? 'UPLOAD_QUOTA_UNAVAILABLE' : 'UPLOAD_REJECTED',
      };
      // Unsupported content types / invalid boundaries may fail before Multer
      // installs the guarded stream. Never leave their unread body draining
      // on a keep-alive connection without a byte/deadline meter.
      if ((phase === 'admission' || (phase === 'staging' && !countBody)) && !req.readableEnded) {
        failStream(Object.assign(new Error(body.error), { status, code: body.code || 'UPLOAD_REJECTED' }));
      } else res.status(status).json(body);
    }
    logger.warn('Public upload rejected', { code: err.code, error: err.message });
  } finally {
    req.removeListener('aborted', cancelImageWork);
    res.removeListener('close', cancelImageWork);
    clearTimeout(timer);
    if (countBody) req.removeListener('data', countBody);
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
