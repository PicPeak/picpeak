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
 * covered by its own tests. A runtime that can't start a worker falls back
 * to this process too, as the validator does.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { AppError } = require('../../utils/errors');

// A contract of a few hundred pages with a bundled font renders in well under
// 100 MB; the limit is there for the document that doesn't.
const WORKER_HEAP_MB = 256;
const WORKER_TIMEOUT_MS = 60000;
// See utils/pdfValidation: process-wide, so a false refusal is possible under
// unrelated load, never a false pass.
const RSS_CEILING_BYTES = 1024 * 1024 * 1024;
const RSS_SAMPLE_MS = 100;
const MAX_CONCURRENT = 2;
const WORKER_FILE = path.join(__dirname, 'renderWorker.js');
const KINDS = ['quote', 'invoice', 'contract', 'insertBeforeLastPage', 'mergePdfs'];

let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

const renderFailed = () => new AppError('The document could not be rendered', 422, 'PDF_RENDER_FAILED');

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
  await acquire();
  try {
    return await runInWorker(kind, payload, options);
  } finally {
    release();
  }
}

function runInWorker(kind, payload, { heapMb = WORKER_HEAP_MB, timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  const logger = require('../../utils/logger');
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_FILE, {
        workerData: { kind, payload },
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(64, heapMb) },
      });
    } catch (err) {
      if (err && err.name === 'DataCloneError') {
        // A context that can't cross the thread boundary is a bug in the
        // caller, not the document: say so in the log, and still render.
        logger.warn('PDF render context could not be sent to the render worker', { kind, err: err.message });
      }
      runRender(kind, payload).then(resolve, reject);
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
      if (process.memoryUsage().rss - startedAt > RSS_CEILING_BYTES) {
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
  WORKER_HEAP_MB,
  WORKER_TIMEOUT_MS,
  renderInWorker,
  runRender,
};
