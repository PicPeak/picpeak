'use strict';

/** Worker side of utils/fontValidation: one font, checked with its own heap. */

const { parentPort, workerData } = require('worker_threads');
const { inspectFont } = require('./fontInspect');

try {
  parentPort.postMessage({ ok: true, info: inspectFont(Buffer.from(workerData.buffer)) });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: {
      message: (err && err.message) || 'The font file could not be read',
      code: (err && err.code) || 'FONT_MALFORMED',
    },
  });
}
