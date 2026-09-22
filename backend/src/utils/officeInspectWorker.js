'use strict';

/**
 * Worker side of utils/officeValidation: inspects one office document
 * (utils/officeInspect) with a heap limit of its own, so a crafted archive
 * only ends this thread.
 */

const { parentPort, workerData } = require('worker_threads');
const { inspectOffice } = require('./officeInspect');

(async () => {
  try {
    const { file, format, limits } = workerData;
    parentPort.postMessage({ ok: true, info: await inspectOffice(file, format, limits) });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: err && err.message ? err.message : 'The document could not be read',
        code: (err && err.code) || 'DOCUMENT_NOT_VALID',
        statusCode: (err && err.statusCode) || 400,
      },
    });
  }
})();
