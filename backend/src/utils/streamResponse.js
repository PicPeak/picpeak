/**
 * Pipe a file/storage stream to an Express response without betting the
 * process on the source still being there (#1128).
 *
 * `fs.createReadStream` — what LocalFsStorage.get() returns — is LAZY. It
 * resolves immediately and only opens the file on a later tick, so an ENOENT
 * arrives AFTER the `await` returned and outside the route's try/catch. An
 * EventEmitter that emits 'error' with no listener throws, and an uncaught
 * throw from an I/O callback is not something Express can catch: Node exits.
 *
 * That is how one missing thumbnail tier took down every gallery on the
 * install — the process died on the first grid load and only came back
 * because Docker restarted it.
 *
 * The window is real and cannot be closed by a stat() beforehand: between the
 * stat and the open, another request regenerating the same derivative can
 * unlink it. So the handler is the fix, not the preflight.
 */

const logger = require('./logger');
const { isStorageUnavailableError, isStorageNotFoundError } = require('../services/storage/storageErrors');

/**
 * @param {import('stream').Readable} stream  source, already opened or lazy
 * @param {import('express').Response} res
 * @param {object}  [options]
 * @param {string}  [options.context]  what was being served, for the log line
 * @param {number}  [options.missingStatus=404]  status when the source is gone
 * @param {(res: import('express').Response) => void} [options.onStorageUnavailable]
 *        answers in place of the 500 when the stream fails, before any byte
 *        is sent, because the storage backend could not be reached
 */
function pipeStreamToResponse(stream, res, options = {}) {
  const { context = 'file', missingStatus = 404, onStorageUnavailable } = options;

  stream.on('error', (err) => {
    // The client is gone (or the stream was torn down because it left), or
    // the response is already complete: there is nobody left to answer, and
    // a 404/500 written now either goes nowhere or writes after end.
    if (res.destroyed || res.writableEnded) {
      logger.debug(`Stream for ${context} failed after the response was over: ${err && err.message}`);
      return;
    }

    const gone = err && (err.code === 'ENOENT' || err.code === 'EISDIR');

    // Once bytes are on the wire the status line is spent — there is no way to
    // turn this into a 404. Destroy the response so the client sees a broken
    // connection rather than a silently truncated image it would cache.
    if (res.headersSent) {
      logger.warn(`Stream failed mid-response for ${context}: ${err.message}`);
      res.destroy(err);
      return;
    }

    // Every header staged for the FILE now describes a body that will never
    // be sent. They are cleared rather than left to Express, which does not
    // overwrite a Content-Type that is already set — so without this the JSON
    // error goes out as `image/jpeg`, or as an `application/zip` attachment
    // that saves to disk as a corrupt download.
    //
    // Cache-Control matters most. The image routes stage `max-age=1800` (the
    // hero route 3600), so a 404 from the regeneration race — the transient
    // case this whole helper exists for — would be cached as a broken tile for
    // up to an hour after the tier finished generating.
    res.removeHeader('Content-Length');
    res.removeHeader('ETag');
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Disposition');
    // Range headers describe the body that is no longer coming. Left behind,
    // a 500 goes out still advertising `Content-Range: bytes 0-9/40`, which
    // tells a resuming client the error response IS the partial content.
    res.removeHeader('Content-Range');
    res.removeHeader('Accept-Ranges');
    res.setHeader('Cache-Control', 'no-store');

    if (gone) {
      // Expected under the regeneration race — the tier existed at stat time
      // and was replaced before the open. One broken tile, not an outage.
      logger.warn(`Source vanished while serving ${context}: ${err.message}`);
      res.status(missingStatus).json({ error: 'File not found' });
      return;
    }

    // S3 resolves get() once the response headers are in; a timeout or reset
    // while the body is read arrives here, not in the caller's catch. A route
    // with its own answer for an unreachable backend gets to give it.
    if (onStorageUnavailable && isStorageUnavailableError(err)) {
      logger.warn(`Storage unavailable while serving ${context}: ${err.message}`);
      onStorageUnavailable(res);
      return;
    }

    logger.error(`Failed to stream ${context}`, { error: err.message, code: err.code });
    res.status(500).json({ error: 'Failed to serve file' });
  });

  // The caller awaited storage.get() before handing the stream over. A client
  // that left during that await has already emitted 'close', so the listener
  // below would never fire and pipe() into a destroyed response just parks
  // the source. For S3 that is an opened GetObject body holding a pooled
  // socket until socketTimeout; under fast scrolling, enough of them drain
  // the pool. An already-ended response has nowhere to put the bytes either.
  // req.aborted covers an HTTP/1.1 pipelined request whose response was still
  // queued behind another when the socket closed: Node never assigned it the
  // socket, so it is neither destroyed nor ever sees 'close'.
  if (res.destroyed || res.writableEnded || res.req?.aborted) {
    stream.destroy();
    return;
  }

  // A client that navigates away mid-download leaves the source handle open
  // otherwise; on a gallery grid that is one leaked fd per abandoned tile.
  res.on('close', () => {
    if (!res.writableEnded) stream.destroy();
  });

  stream.pipe(res);
}

/**
 * A file stat() found and the read then did not (issues 2118, 2129): removed
 * in between, by a replacement, a delete or a re-render. Answered as the
 * failed stat would have been (`status`, 404 unless the route answers a
 * missing file otherwise), not a 500. The headers staged for the file go
 * first: Express keeps a Content-Type that is already set, and the cache
 * lifetime staged for the file would keep the 404. False when the error is
 * anything else, or the response has already started.
 */
function answerVanished(res, error, message, status = 404) {
  if (res.headersSent || !isStorageNotFoundError(error)) return false;
  for (const name of ['ETag', 'Content-Type', 'Content-Length', 'Content-Disposition', 'Content-Range', 'Accept-Ranges']) {
    res.removeHeader(name);
  }
  res.set('Cache-Control', 'no-store');
  res.status(status).json({ error: message });
  return true;
}

module.exports = { pipeStreamToResponse, answerVanished };
