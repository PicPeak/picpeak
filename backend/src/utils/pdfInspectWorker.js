'use strict';

/**
 * Worker side of utils/pdfValidation: parses and scans one PDF with a heap
 * limit of its own.
 *
 * pdf-lib inflates every object stream on load, and the upload cap is on the
 * compressed size — a 1.5 MB file can expand into gigabytes, which in the
 * server process means the whole install stops. Here the parse runs with
 * `resourceLimits`, so the same file only kills this thread and the upload
 * comes back as a refusal.
 */

const { parentPort, workerData } = require('worker_threads');
const { inspectPdf } = require('./pdfInspect');

(async () => {
  try {
    const { buffer, options } = workerData;
    const info = await inspectPdf(Buffer.from(buffer), options);
    parentPort.postMessage({
      ok: true,
      info: {
        pages: info.pages,
        bytes: info.bytes,
        sha256: info.sha256,
        normalised: info.normalised,
      },
    });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: err && err.message ? err.message : 'The PDF could not be read',
        code: (err && err.code) || 'PDF_MALFORMED',
        statusCode: (err && err.statusCode) || 400,
      },
    });
  }
})();
