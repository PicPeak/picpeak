'use strict';

/**
 * PDF rendering off the main thread (#1445), modelled on
 * utils/pdfValidation: each render — a quote, an invoice, a contract, or a
 * merge of contract attachments — runs in a worker thread with a heap
 * limit, a timeout and a watch on the process's memory, at most two at once.
 *
 * The renderers make no network calls and read only server-resolved font
 * and logo paths, so the exposure this closes is resource exhaustion: a
 * pathological document (a 20 000-character clause, a huge table, a merge
 * of large attachments) used to render on the thread that serves every
 * request, with no bound on its time or memory. Here it can only end its own
 * thread, and the caller gets `422 PDF_RENDER_FAILED`.
 *
 * `PDF_RENDER_ISOLATION=off` renders in this process instead — the test
 * suite sets it, so its spies on the renderers keep working; the worker is
 * covered by its own tests. Otherwise there is no silent fallback: a worker
 * that can't be started refuses the render (422) and logs why, rather than
 * rendering without limits.
 *
 * At most two renders run at once and at most MAX_WAITING wait; beyond that
 * a render is refused with 503 PDF_RENDER_BUSY and a Retry-After. The time
 * a render waits counts against its timeout.
 */

const path = require('path');
const workerThreads = require('worker_threads');
const { AppError } = require('../../utils/errors');

// A contract of a few hundred pages with a bundled font renders in well under
// 100 MB; the limit is there for the document that doesn't.
const WORKER_HEAP_MB = 256;
const WORKER_TIMEOUT_MS = 60000;
// See utils/pdfValidation: process-wide, so a false refusal is possible under
// unrelated load, never a false pass.
const RSS_CEILING_BYTES = 1024 * 1024 * 1024;
const RSS_SAMPLE_MS = 100;
// A merge holds its inputs several times over while it runs — the caller's
// buffers, the worker's copy, pdf-lib's parse and the merged output (all
// outside the V8 heap, so the heap limit doesn't see them). Measured: a
// contract with 20 attachments of 19 MB / 100 pages each (380 MB, the most
// the attachment validator lets a contract carry) grows the process by
// ~1.6 GB, 4.2x its input. The ceiling for a merge is therefore 1 GB plus
// 5x the input: at most 1 GB + 2 GB for the largest contract the upload
// checks accept, so an accepted contract never fails at send. The inputs
// passed the validator's inflate budget already.
const MERGE_RSS_FACTOR = 5;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 20;
const RETRY_AFTER_SECONDS = 10;
const WORKER_FILE = path.join(__dirname, 'renderWorker.js');
const KINDS = ['quote', 'invoice', 'contract', 'insertBeforeLastPage', 'mergePdfs'];

let running = 0;
const waiting = [];

const renderFailed = () => new AppError('The document could not be rendered', 422, 'PDF_RENDER_FAILED');
function renderBusy() {
  const err = new AppError('Too many documents are being rendered. Please try again shortly.', 503, 'PDF_RENDER_BUSY');
  err.retryAfter = RETRY_AFTER_SECONDS;
  return err;
}

/** A render slot, within `timeoutMs`; refuses at once when the queue is full. */
function acquire(timeoutMs) {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) return Promise.reject(renderBusy());
  return new Promise((resolve, reject) => {
    const entry = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
      require('../../utils/logger').warn('PDF render timed out waiting for a slot', { timeoutMs });
      reject(renderFailed());
    }, timeoutMs);
    waiting.push(entry);
  });
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

const toBuffer = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength));

/**
 * The render itself, in whichever thread calls it. Returns `{ buffer, … }`:
 * `slots` for a contract, `ranges` / `lastPageIndex` for a merge.
 */
async function runRender(kind, payload) {
  const pdfService = require('../pdfService');
  const merge = require('./merge');
  switch (kind) {
  case 'quote':
  case 'invoice':
    return { buffer: await pdfService._raw.renderDocument(kind, payload) };
  case 'contract':
    return pdfService._raw.renderContract(payload);
  case 'insertBeforeLastPage':
    return merge._raw.insertBeforeLastPage(
      toBuffer(payload.documentBuffer), payload.inserts.map(toBuffer), payload.info || {},
    );
  case 'mergePdfs':
    return merge._raw.mergePdfs(payload.parts.map(toBuffer), payload.info || {});
  default:
    throw new Error(`Unknown render kind: ${kind}`);
  }
}

/** The bytes a merge takes in (0 for a render). */
function mergeInputBytes(kind, payload) {
  const size = (b) => (b && typeof b.byteLength === 'number' ? b.byteLength : 0);
  if (kind === 'insertBeforeLastPage') return size(payload.documentBuffer) + payload.inserts.reduce((n, b) => n + size(b), 0);
  if (kind === 'mergePdfs') return payload.parts.reduce((n, b) => n + size(b), 0);
  return 0;
}

function isolationEnabled() {
  return String(process.env.PDF_RENDER_ISOLATION || '').toLowerCase() !== 'off';
}

/**
 * Render `kind` with `payload` in a worker. `options.heapMb` / `timeoutMs`
 * exist so a test can pin what happens past the limits; callers use the
 * defaults.
 */
async function renderInWorker(kind, payload, options = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown render kind: ${kind}`);
  if (!isolationEnabled() && !options.forceWorker) return runRender(kind, payload);
  const timeoutMs = options.timeoutMs || WORKER_TIMEOUT_MS;
  const startedAt = Date.now();
  await acquire(timeoutMs);
  try {
    // The wait counts: the whole render, queued or running, gets timeoutMs.
    return await runInWorker(kind, payload, {
      rssCeilingBytes: RSS_CEILING_BYTES + MERGE_RSS_FACTOR * mergeInputBytes(kind, payload),
      ...options,
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
    });
  } finally {
    release();
  }
}

function runInWorker(kind, payload, {
  heapMb = WORKER_HEAP_MB, timeoutMs = WORKER_TIMEOUT_MS, rssCeilingBytes = RSS_CEILING_BYTES,
} = {}) {
  const logger = require('../../utils/logger');
  return new Promise((resolve, reject) => {
    let worker;
    try {
      // Through the module object, so a test can make construction fail.
      worker = new workerThreads.Worker(WORKER_FILE, {
        workerData: { kind, payload },
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(64, heapMb) },
      });
    } catch (err) {
      // No silent fallback to an unbounded render in this process: the
      // document is refused and the cause logged (a context that can't be
      // cloned is a bug in the caller; a runtime without workers needs
      // PDF_RENDER_ISOLATION=off, deliberately).
      logger.error('PDF render worker could not be started', { kind, name: err && err.name, err: err && err.message });
      reject(renderFailed());
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      logger.warn('PDF render timed out', { kind, timeoutMs });
      finish(reject, renderFailed());
    }, timeoutMs);
    const startedAt = process.memoryUsage().rss;
    const watchdog = setInterval(() => {
      if (process.memoryUsage().rss - startedAt > rssCeilingBytes) {
        logger.warn('PDF render exceeded the memory ceiling', { kind });
        finish(reject, renderFailed());
      }
    }, RSS_SAMPLE_MS);
    worker.on('message', (msg) => {
      if (msg && msg.log) {
        const fn = logger[msg.log.level] || logger.info;
        fn.call(logger, msg.log.message, msg.log.meta);
        return;
      }
      if (msg && msg.ok) {
        finish(resolve, { ...msg.rest, buffer: toBuffer(msg.buffer) });
        return;
      }
      const error = (msg && msg.error) || {};
      // A refusal the renderer raised on purpose keeps its status and code;
      // anything else is a document that could not be rendered.
      if (error.statusCode && error.code) {
        finish(reject, new AppError(error.message, error.statusCode, error.code));
        return;
      }
      logger.warn('PDF render failed', { kind, err: error.message });
      finish(reject, renderFailed());
    });
    worker.on('error', (err) => {
      logger.warn('PDF render worker died', { kind, code: err && err.code, err: err && err.message });
      finish(reject, renderFailed());
    });
    worker.on('exit', () => finish(reject, renderFailed()));
  });
}

module.exports = {
  MAX_WAITING,
  WORKER_HEAP_MB,
  WORKER_TIMEOUT_MS,
  renderInWorker,
  runRender,
  _internal: { mergeInputBytes, MERGE_RSS_FACTOR, RSS_CEILING_BYTES },
};
