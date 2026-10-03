'use strict';

/**
 * A budget on what pdf-lib actually decodes, measured where it grows.
 *
 * Every pdf-lib decoder — FlateStream, LZWStream, Ascii85Stream,
 * AsciiHexStream, RunLengthStream — extends `DecodeStream`, and all of its
 * output growth goes through `DecodeStream.prototype.ensureBuffer`. Metering
 * there counts exactly what the parser inflates, whatever framing the file
 * uses: `/Filter` chains, a zlib header the raw scan doesn't recognise,
 * `stream` followed by a space, an `/Length` pointing somewhere else.
 *
 * The raw-bytes pass in pdfInspect stays in front of it as a cheap first
 * refusal — it costs nothing on a legitimate file and stops the common bomb
 * before the parser is entered at all — but this is the guard that does not
 * depend on reading the container the same way pdf-lib does.
 *
 * `patch()` returns a `restore()` and a `tripped()`. The metering is global
 * to the process while it is in place, so each check runs in its own worker
 * thread (see pdfValidation) — that, not serialisation, is what keeps two
 * checks from sharing one patched prototype. In the fallback path where no
 * worker can be created, `patch()` nests: only the outermost `restore()` puts
 * the original method back, so two overlapping checks in one process can't
 * leave `ensureBuffer` metered for every later pdf-lib call.
 *
 * `tripped()` matters because throwing is not enough on its own: pdf-lib's
 * parser has `throwOnInvalidObject: false`, so a throw from inside its object
 * loop is logged and the object skipped — the load then "succeeds" with the
 * bomb silently dropped. The caller checks `tripped()` after the load and
 * after the save and refuses.
 */

const DecodeStream = require('pdf-lib/cjs/core/streams/DecodeStream').default;

class DecodeBudgetExceeded extends Error {
  constructor(budget) {
    super(`pdf decoding exceeded the ${budget} byte budget`);
    this.name = 'DecodeBudgetExceeded';
    this.code = 'PDF_DECODE_BUDGET';
  }
}

/**
 * Meter `DecodeStream` growth against `budget` bytes in total.
 * @returns {{ restore: () => void, spent: () => number }}
 */
// The method as it was before any patch, and how many patches are active.
// Only the outermost restore puts it back (see the header).
const pristine = DecodeStream.prototype.ensureBuffer;
let depth = 0;

function patch(budget) {
  const original = DecodeStream.prototype.ensureBuffer;
  let spent = 0;
  let tripped = false;
  let restored = false;
  depth += 1;
  const exceeded = () => {
    tripped = true;
    return new DecodeBudgetExceeded(budget);
  };
  DecodeStream.prototype.ensureBuffer = function meteredEnsureBuffer(requested) {
    const before = this.buffer.byteLength;
    // Refuse the request that would cross the budget before it allocates,
    // then charge what was actually allocated: ensureBuffer grows by
    // doubling, so the realised growth is bigger than the request and
    // charging the request alone under-counts by most of the buffer.
    if (requested > before && spent + (requested - before) > budget) throw exceeded();
    const buffer = original.call(this, requested);
    spent += Math.max(0, buffer.byteLength - before);
    if (spent > budget) throw exceeded();
    return buffer;
  };
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      depth -= 1;
      if (depth === 0) DecodeStream.prototype.ensureBuffer = pristine;
    },
    spent: () => spent,
    // True once the budget was hit, whether or not the caller saw the throw:
    // pdf-lib swallows it and carries on.
    tripped: () => tripped,
  };
}

module.exports = { patch, DecodeBudgetExceeded };
