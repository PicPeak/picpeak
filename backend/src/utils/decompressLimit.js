const { Transform } = require('stream');

// Bound the EXPANDED size of a gzipped database dump (GHSA-h652). gunzip
// happily inflates a small crafted .gz into an unbounded stream, filling the
// disk before any later validation runs. The default is deliberately
// generous — real database dumps are large — and overridable for installs
// with genuinely bigger data. Read at call time.
function maxDecompressedBytes() {
  const configured = Number(process.env.RESTORE_MAX_DECOMPRESSED_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 50 * 1024 * 1024 * 1024; // 50 GB
}

class DecompressLimitError extends Error {}

// A pass-through that fails the pipeline the moment the limit is crossed,
// before the chunk that crosses it is passed on.
function decompressLimiter(maxBytes = maxDecompressedBytes()) {
  let written = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (written > maxBytes) {
        return cb(new DecompressLimitError(
          `Decompressed size exceeds limit of ${maxBytes} bytes — refusing to continue`
        ));
      }
      cb(null, chunk);
    },
  });
}

module.exports = { maxDecompressedBytes, decompressLimiter, DecompressLimitError };
