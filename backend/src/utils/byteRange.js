/**
 * One `Range: bytes=…` request against a file of `size` bytes: the first and
 * last byte to send, or null when the header is absent, malformed, names
 * several ranges or cannot be satisfied. `bytes=500-`, `bytes=0-99` and the
 * suffix form `bytes=-500` (the last 500 bytes) are understood.
 */
function parseByteRange(header, size) {
  if (!header || typeof header !== 'string' || !size) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = parseInt(rawEnd, 10);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

module.exports = { parseByteRange };
