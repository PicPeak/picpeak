'use strict';

/**
 * The gate in front of utils/officeInspect (#1444 slice 7): the checks run
 * in a worker thread with a heap limit, a time limit and at most two at
 * once — the same budget pattern as utils/pdfValidation. A crafted archive
 * that makes the zip reader misbehave ends that thread, and the upload is
 * refused with DOCUMENT_TOO_COMPLEX.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { AppError } = require('./errors');

const WORKER_HEAP_MB = 256;
const WORKER_TIMEOUT_MS = 30000;
const WORKER_FILE = path.join(__dirname, 'officeInspectWorker.js');
const MAX_CONCURRENT = 2;
// Checks beyond the two running ones wait, but only so many: past that the
// upload is refused as "try again later" (503) instead of piling up
// requests, each holding its temp file, behind a 30 s budget apiece.
const MAX_WAITING = 20;
let running = 0;
const waiting = [];

const unavailable = (status) => new AppError(
  'The document cannot be checked right now. Please try again later.', status, 'DOCUMENT_CHECK_UNAVAILABLE',
);

function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) return Promise.reject(unavailable(503));
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

const tooComplex = () => new AppError(
  'This document is too complex to check. Please save it again from your office program and upload that file.',
  400, 'DOCUMENT_TOO_COMPLEX',
);

/**
 * @param {string} file   local path of the upload
 * @param {'docx'|'xlsx'|'odt'|'ods'} format
 * @returns {Promise<{ entries: number, expandedBytes: number }>}
 * Throws a 400 AppError with a stable code (DOCUMENT_NOT_VALID,
 * DOCUMENT_ACTIVE_CONTENT, DOCUMENT_ENCRYPTED, DOCUMENT_TOO_COMPLEX), or a
 * DOCUMENT_CHECK_UNAVAILABLE: 422 when no worker can be started, 503 when
 * MAX_WAITING checks are already queued.
 */
async function validateOffice(file, format, { limits = {}, heapMb = WORKER_HEAP_MB, timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  await acquire(); // a refusal here holds no slot, so it skips release()
  try {
    return await new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(WORKER_FILE, {
          workerData: { file, format, limits },
          resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(64, heapMb) },
        });
      } catch (_) {
        // No worker available (an unusual runtime). Inspecting here would run
        // without the heap and time budget the worker gives, so the upload
        // is refused as "try again later" rather than checked unbudgeted.
        reject(unavailable(422));
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
        if (msg && msg.ok) return finish(resolve, msg.info);
        const e = (msg && msg.error) || {};
        return finish(reject, new AppError(e.message || 'The document could not be read', e.statusCode || 400, e.code || 'DOCUMENT_NOT_VALID'));
      });
      worker.on('error', (err) => finish(reject, err && err.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? tooComplex() : new AppError('The document could not be read', 400, 'DOCUMENT_NOT_VALID')));
      worker.on('exit', () => finish(reject, tooComplex()));
    });
  } finally {
    release();
  }
}

module.exports = { MAX_CONCURRENT, MAX_WAITING, validateOffice };
