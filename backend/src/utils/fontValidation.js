'use strict';

/**
 * The gate in front of utils/fontInspect (#1445): a font is parsed in a
 * worker thread with a heap limit and a timeout, like PDFs are
 * (utils/pdfValidation) — a crafted font only ends its own thread.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { AppError } = require('./errors');
const { MAX_BYTES, inspectFont } = require('./fontInspect');

const WORKER_HEAP_MB = 128;
const WORKER_TIMEOUT_MS = 10000;
const WORKER_FILE = path.join(__dirname, 'fontInspectWorker.js');

const tooComplex = () => new AppError('This font file is too complex to check', 400, 'FONT_TOO_COMPLEX');

/** `{ format, bytes, sha256, numGlyphs, familyName }`, or a 400 with a stable code. */
async function validateFont(buffer, { timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AppError('The file is empty', 400, 'FONT_NOT_A_FONT');
  if (buffer.length > MAX_BYTES) throw new AppError('A font file may be at most 5 MB', 400, 'FONT_TOO_LARGE');
  const bytes = new Uint8Array(buffer);
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_FILE, {
        workerData: { buffer: bytes },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32 },
      });
    } catch (_) {
      // No worker available: check in this process rather than refuse every upload.
      try { resolve(inspectFont(buffer)); } catch (err) { reject(err); }
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, tooComplex()), timeoutMs);
    worker.on('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.info);
      else finish(reject, new AppError(msg.error.message, 400, msg.error.code));
    });
    worker.on('error', () => finish(reject, tooComplex()));
    worker.on('exit', () => finish(reject, tooComplex()));
  });
}

module.exports = { MAX_BYTES, validateFont };
