/**
 * Runs an edit's pixel pass (photoEditMath.renderEdit) off the main thread
 * (issue 2619): a full-size render takes seconds, which would otherwise stall
 * every request the process serves. The source is transferred, not copied.
 */
const { parentPort, workerData } = require('worker_threads');
const { renderEdit } = require('../utils/photoEditMath');

const { buffer, byteOffset, length, bits, width, height, channels, params, options } = workerData;
const src = bits === 16 ? new Uint16Array(buffer, byteOffset, length) : new Uint8Array(buffer, byteOffset, length);
const out = renderEdit(src, width, height, channels, params, options);
const data = out.data;
parentPort.postMessage({ width: out.width, height: out.height, buffer: data.buffer, byteOffset: data.byteOffset, length: data.length },
  [data.buffer]);
