'use strict';

const fs = require('fs');
const { TextDecoder } = require('util');

// One exported row is one NDJSON line. The largest ones PicPeak writes are
// text and JSON columns (email bodies with inline images, page CSS, contract
// HTML, settings blobs), so the default is far above any of them; raise it
// with PICPEAK_IMPORT_MAX_ROW_BYTES for an install that outgrew it.
const MAX_ROW_BYTES = 64 * 1024 * 1024;
const MAX_TABLE_BYTES = 8 * 1024 ** 3;
const MAX_TABLE_ROWS = 10000000;
const MAX_COLUMNS = 512;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_ROWS = 100;
const MAX_BATCH_BINDINGS = 900; // Also safe on older SQLite builds.
const decoder = new TextDecoder('utf-8', { fatal: true });

function refusal(message) {
  return Object.assign(new Error(message), { code: 'PICPEAK_IMPORT_ROW_LIMIT', statusCode: 413 });
}

function rowByteLimit() {
  const value = Number(process.env.PICPEAK_IMPORT_MAX_ROW_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : MAX_ROW_BYTES;
}

function bounds(options) {
  const limits = { rowBytes: rowByteLimit(), tableBytes: MAX_TABLE_BYTES, rows: MAX_TABLE_ROWS };
  for (const key of Object.keys(limits)) {
    if (options[key] === undefined) continue;
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0 || options[key] > limits[key]) throw refusal(`Invalid portable NDJSON ${key} limit`);
    limits[key] = options[key];
  }
  return limits;
}

async function* readNdjson(filePath, options = {}) {
  const limit = bounds(options);
  let handle;
  try { handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (error) {
    if (error.code === 'ENOENT' && options.allowMissing) return;
    throw error;
  }
  let tail = Buffer.alloc(0);
  let bytes = 0;
  let rows = 0;
  let stat;
  function parse(line) {
    const text = decoder.decode(line);
    if (!text.trim()) return null;
    if (++rows > limit.rows) throw refusal('Portable table has too many rows');
    const row = JSON.parse(text);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw refusal('Portable NDJSON must contain object rows');
    const columns = Object.keys(row);
    if (!columns.length || columns.length > MAX_COLUMNS
        || columns.some(name => ['__proto__', 'constructor', 'prototype'].includes(name))) throw refusal('Portable row has invalid or excessive columns');
    return { row, bytes: line.length };
  }
  try {
    stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size > limit.tableBytes) throw refusal('Portable table exceeds its file bound');
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      bytes += chunk.length;
      if (bytes > limit.tableBytes) throw refusal('Portable table exceeds its byte budget');
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end === -1 ? chunk.length : end);
        // Enforce BEFORE concatenation, UTF8 decoding or JSON.parse.
        if (tail.length + part.length > limit.rowBytes) throw refusal('Portable NDJSON row exceeds its byte budget');
        tail = tail.length ? Buffer.concat([tail, part]) : part;
        if (end === -1) break;
        const parsed = parse(tail);
        if (parsed) yield parsed;
        tail = Buffer.alloc(0);
        start = end + 1;
      }
    }
    if (tail.length) {
      const parsed = parse(tail);
      if (parsed) yield parsed;
    }
    const after = await handle.stat();
    if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw refusal('Portable table changed while reading');
  } finally { await handle.close(); }
}

async function* rowBatches(filePath, options = {}) {
  let batch = [];
  let bytes = 0;
  const columns = new Set();
  for await (const parsed of readNdjson(filePath, options)) {
    const names = Object.keys(parsed.row);
    const width = new Set([...columns, ...names]).size;
    if (batch.length && (batch.length >= MAX_BATCH_ROWS || bytes + parsed.bytes > MAX_BATCH_BYTES
        || width * (batch.length + 1) > MAX_BATCH_BINDINGS)) {
      yield batch;
      batch = [];
      bytes = 0;
      columns.clear();
    }
    batch.push(parsed.row);
    bytes += parsed.bytes;
    names.forEach(name => columns.add(name));
  }
  if (batch.length) yield batch;
}

module.exports = { readNdjson, rowBatches, rowByteLimit, MAX_ROW_BYTES, MAX_TABLE_BYTES, MAX_TABLE_ROWS,
  MAX_COLUMNS, MAX_BATCH_BYTES, MAX_BATCH_ROWS, MAX_BATCH_BINDINGS };
