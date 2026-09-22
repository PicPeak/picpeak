'use strict';

/**
 * Worker side of services/pdf/renderIsolation: renders one document — or
 * merges PDFs — in a thread with a heap limit of its own (#1445).
 *
 * Everything a render needs arrives as plain data plus server-resolved file
 * paths (fonts, logo), so the context crosses the thread boundary as it is.
 * The worker calls the in-process renderers directly; it never goes through
 * the isolation gate again.
 *
 * The renderer logs through utils/logger. Two threads rotating the same log
 * files is asking for trouble, so here the logger is a stand-in that hands
 * each entry to the parent, which logs it.
 */

const Module = require('module');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const loggerPath = require.resolve('../../utils/logger');
const forward = (level) => (message, meta) => {
  try {
    parentPort.postMessage({ log: { level, message: String(message), meta: meta ? JSON.parse(JSON.stringify(meta)) : undefined } });
  } catch (_) { /* a log entry is never worth failing a render */ }
};
const stub = new Module(loggerPath);
stub.filename = loggerPath;
stub.paths = Module._nodeModulePaths(path.dirname(loggerPath));
stub.loaded = true;
stub.exports = {
  error: forward('error'), warn: forward('warn'), info: forward('info'), debug: forward('debug'),
};
require.cache[loggerPath] = stub;

const { runRender } = require('./renderIsolation');

(async () => {
  try {
    const { kind, payload } = workerData;
    const result = await runRender(kind, payload);
    const bytes = new Uint8Array(result.buffer.buffer, result.buffer.byteOffset, result.buffer.byteLength);
    // Copy out of Node's shared buffer pool before transferring: a pooled
    // Buffer's ArrayBuffer holds other allocations too.
    const out = bytes.slice();
    const { buffer, ...rest } = result;
    parentPort.postMessage({ ok: true, buffer: out, rest }, [out.buffer]);
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: err && err.message ? err.message : 'The document could not be rendered',
        code: (err && err.code) || null,
        statusCode: (err && err.statusCode) || null,
      },
    });
  }
})();
