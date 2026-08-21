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

/**
 * @param {import('stream').Readable} stream  source, already opened or lazy
 * @param {import('express').Response} res
 * @param {object}  [options]
 * @param {string}  [options.context]  what was being served, for the log line
 * @param {number}  [options.missingStatus=404]  status when the source is gone
 */
function pipeStreamToResponse(stream, res, options = {}) {
  const { context = 'file', missingStatus = 404 } = options;

  stream.on('error', (err) => {
    const gone = err && (err.code === 'ENOENT' || err.code === 'EISDIR');

    // Once bytes are on the wire the status line is spent — there is no way to
    // turn this into a 404. Destroy the response so the client sees a broken
    // connection rather than a silently truncated image it would cache.
    if (res.headersSent) {
      logger.warn(`Stream failed mid-response for ${context}: ${err.message}`);
      res.destroy(err);
      return;
    }

    // Content-Length was set from a stat that no longer describes anything.
    // Leaving it on a JSON error body makes the response self-contradictory.
    res.removeHeader('Content-Length');
    res.removeHeader('ETag');

    if (gone) {
      // Expected under the regeneration race — the tier existed at stat time
      // and was replaced before the open. One broken tile, not an outage.
      logger.warn(`Source vanished while serving ${context}: ${err.message}`);
      res.status(missingStatus).json({ error: 'File not found' });
      return;
    }

    logger.error(`Failed to stream ${context}`, { error: err.message, code: err.code });
    res.status(500).json({ error: 'Failed to serve file' });
  });

  // A client that navigates away mid-download leaves the source handle open
  // otherwise; on a gallery grid that is one leaked fd per abandoned tile.
  res.on('close', () => {
    if (!res.writableEnded) stream.destroy();
  });

  stream.pipe(res);
}

module.exports = { pipeStreamToResponse };
