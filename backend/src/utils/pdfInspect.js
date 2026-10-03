'use strict';

/**
 * The PDF content checks themselves (#1445 contract attachments); the gate
 * that runs them under a heap limit is utils/pdfValidation.
 *
 * A file is judged by its bytes, never its name or declared type:
 *   - it must start with the `%PDF-` signature and parse with pdf-lib;
 *   - encrypted files are refused (they can't be merged and can't be
 *     checked);
 *   - active or embedded content is refused: JavaScript, launch, import and
 *     form-submit actions, document or page "additional actions", embedded
 *     files, XFA forms and rich media. Plain links (URI / GoTo actions) and
 *     an OpenAction that is only a destination are fine;
 *   - size and page-count caps keep a crafted file from exhausting the
 *     renderer.
 *
 * pdf-lib decompresses object streams on load, so the scan also sees
 * dictionaries that sit inside compressed streams.
 *
 * How much it may decompress is metered where pdf-lib grows its decode
 * buffers (utils/pdfDecodeBudget), so the cap holds whatever framing the file
 * uses. The raw-bytes pass below is the cheap first refusal in front of it.
 *
 * What is stored is what was checked: the caller writes the bytes pdf-lib
 * wrote back (`normalised`), not the upload. A file can define the same
 * object number twice — pdf-lib keeps the last definition, while a viewer
 * resolves through the xref table, which can point at the first. Storing the
 * re-serialised document drops everything the scan didn't see, so the two
 * can't disagree.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const {
  PDFDocument, PDFDict, PDFName, PDFArray, EncryptedPDFError,
} = require('pdf-lib');
const { AppError } = require('./errors');
const decodeBudget = require('./pdfDecodeBudget');

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 200;
// How much a file may expand to in total. pdf-lib inflates every stream it
// touches into typed arrays, and the upload cap is on the COMPRESSED bytes:
// zlib reaches about 1000:1 on zeros, so 20 MB of upload is ~20 GB of
// inflate. A real 200-page document with images stays far below this.
const DEFAULT_MAX_INFLATE_BYTES = 256 * 1024 * 1024;

// Keys whose presence alone means active or embedded content.
const FORBIDDEN_KEYS = new Set([
  '/JS', '/JavaScript', '/AA', '/EmbeddedFiles', '/EmbeddedFile', '/EF', '/XFA', '/RichMedia',
  '/RichMediaContent', '/Launch',
]);
// Values of /S (action type), /Subtype (annotation) or /Type that run code,
// leave the document, send data or carry a file.
const FORBIDDEN_NAMES = new Set([
  '/JavaScript', '/Launch', '/ImportData', '/SubmitForm', '/ResetForm', '/GoToR', '/GoToE',
  '/RichMediaExecute', '/Rendition', '/Sound', '/Movie', '/Hide', '/SetOCGState', '/GoTo3DView',
  '/EmbeddedFile', '/FileAttachment', '/RichMedia', '/Screen', '/3D',
]);
const TYPE_KEYS = new Set(['/S', '/Subtype', '/Type']);
// Nesting deeper than this in one object is itself suspicious.
const MAX_DEPTH = 32;

function refuse(message, code) {
  return new AppError(message, 400, code);
}

function hasPdfSignature(buffer) {
  // The header may follow a few junk bytes; the spec allows it within 1 KB.
  const head = buffer.subarray(0, 1024).toString('latin1');
  return head.includes('%PDF-');
}

/**
 * Walk a value's direct dictionaries and arrays. Actions, name trees and
 * form dictionaries are often nested directly inside another object (an
 * annotation's /A, the catalog's /Names or /AcroForm), so looking at
 * top-level keys alone would miss them. References aren't followed: every
 * indirect object is scanned on its own.
 */
function scanValue(value, depth) {
  if (depth > MAX_DEPTH) return 'nesting';
  if (value instanceof PDFDict) {
    for (const [key, inner] of value.entries()) {
      const name = key.asString();
      if (FORBIDDEN_KEYS.has(name)) return name;
      if (TYPE_KEYS.has(name) && inner instanceof PDFName && FORBIDDEN_NAMES.has(inner.asString())) {
        return inner.asString();
      }
      const hit = scanValue(inner, depth + 1);
      if (hit) return hit;
    }
  } else if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i += 1) {
      const hit = scanValue(value.get(i), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The first forbidden key or name found anywhere in the document, or null. */
function findActiveContent(pdf) {
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    // A stream's dictionary carries its /Type and /Subtype.
    const hit = scanValue(object && object.dict instanceof PDFDict ? object.dict : object, 0);
    if (hit) return hit;
  }
  return null;
}

const tooComplex = () => refuse(
  'This PDF expands to far more than it looks like — it can\'t be checked. '
  + 'Please save it again from your PDF program (print to PDF) and upload that file.',
  'PDF_TOO_COMPLEX',
);

/**
 * Refuse a file whose streams expand past `budget` bytes in total.
 *
 * This runs on the raw bytes, before pdf-lib sees them, because pdf-lib
 * inflates as it parses and its output lives outside the JS heap a worker's
 * `resourceLimits` can cap — a heap limit never fires on that, the process
 * simply grows until the kernel kills it. `zlib.inflateSync` with
 * `maxOutputLength` stops at the budget instead, and the budget shrinks as it
 * goes, so the peak is bounded by the budget rather than by the file.
 *
 * Where a stream ENDS is deliberately not decided here. The `endstream`
 * keyword can appear inside a deflate payload (a stored block makes that
 * trivial), and a guard that cut there inflated a truncated prefix, charged
 * it as damaged, and let the real stream through to pdf-lib — which reads the
 * dictionary's `/Length` and inflates all of it. So each stream is inflated
 * from its start to the end of the file: zlib stops at the end of the deflate
 * data on its own and ignores what follows, so whatever boundary the parser
 * later picks, this has already accounted for at least as much. A damaged or
 * truncated stream is charged with what it actually decoded (Z_SYNC_FLUSH),
 * not with its compressed size.
 */
/**
 * How many bytes `data` inflates to, counted chunk by chunk and abandoned the
 * moment it passes `cap`. Streaming rather than `inflateSync`: measuring with
 * a single output buffer meant the check itself held up to the whole budget
 * in memory, so refusing a bomb cost nearly as much as the bomb. A stream
 * that isn't zlib, or is damaged, is charged with what it managed to decode.
 */
function countInflated(data, cap) {
  return new Promise((resolve, reject) => {
    const inflate = zlib.createInflate();
    let total = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      inflate.removeAllListeners();
      inflate.destroy();
      fn(value);
    };
    inflate.on('data', (chunk) => {
      total += chunk.length;
      if (total > cap) finish(reject, tooComplex());
    });
    inflate.on('end', () => finish(resolve, total));
    inflate.on('error', () => finish(resolve, Math.max(total, 0)));
    inflate.end(data);
  });
}

async function assertInflateWithinBudget(buffer, budget) {
  let remaining = budget;
  let index = 0;
  for (;;) {
    const keyword = buffer.indexOf('stream', index, 'latin1');
    if (keyword === -1) return;
    let from = keyword + 'stream'.length;
    // pdf-lib's `streamEOF1` accepts spaces and tabs between the keyword and
    // the newline, so skipping only CR/LF left the data starting at 0x20 and
    // the stream charged as if it couldn't expand.
    while (buffer[from] === 0x20 || buffer[from] === 0x09) from += 1;
    if (buffer[from] === 0x0d) from += 1;
    if (buffer[from] === 0x0a) from += 1;
    // Advance past the first `endstream` so the next stream is found; the
    // data below deliberately runs past it.
    const firstEnd = buffer.indexOf('endstream', keyword, 'latin1');
    index = firstEnd === -1 ? buffer.length : firstEnd + 'endstream'.length;
    if (from >= buffer.length) return;
    const data = buffer.subarray(from);
    // A zlib stream is any CMF whose low nibble is 8 (the deflate method);
    // 0x78 is only the most common window size, and pdf-lib's FlateStream
    // checks the method nibble alone.
    if ((data[0] & 0x0f) !== 0x08) {
      remaining -= Math.max(0, (firstEnd === -1 ? buffer.length : firstEnd) - from);
    } else {
      remaining -= await countInflated(data, Math.max(1, remaining));
    }
    if (remaining <= 0) throw tooComplex();
  }
}

/**
 * Parse, scan and re-serialise one PDF. Throws a 400 AppError with a stable
 * code: PDF_TOO_LARGE, PDF_NOT_A_PDF, PDF_ENCRYPTED, PDF_MALFORMED,
 * PDF_ACTIVE_CONTENT, PDF_EMPTY, PDF_TOO_MANY_PAGES.
 *
 * Runs wherever it is called — the caller decides whether that is this
 * process or a worker with a heap limit (see pdfValidation.js).
 *
 * `normalised` is the document pdf-lib re-serialised from what this scan
 * saw, and `bytes` / `sha256` describe those bytes: store them, never the
 * upload.
 *
 * @returns {Promise<{ pages: number, bytes: number, sha256: string, normalised: Buffer }>}
 */
async function inspectPdf(buffer, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxPages = DEFAULT_MAX_PAGES,
  maxInflateBytes = DEFAULT_MAX_INFLATE_BYTES,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw refuse('The file is empty', 'PDF_NOT_A_PDF');
  if (buffer.length > maxBytes) {
    throw refuse(`The PDF is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`, 'PDF_TOO_LARGE');
  }
  if (!hasPdfSignature(buffer)) throw refuse('The file is not a PDF', 'PDF_NOT_A_PDF');
  // Before the parser, and before any of it reaches memory it doesn't own.
  await assertInflateWithinBudget(buffer, maxInflateBytes);

  let pdf;
  // Metered for the parse AND the re-serialisation below: `save()` decodes
  // anything the load left lazy.
  const meter = decodeBudget.patch(maxInflateBytes);
  try {
    pdf = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch (err) {
    meter.restore();
    if (err instanceof decodeBudget.DecodeBudgetExceeded) throw tooComplex();
    // pdf-lib's error classes don't set `name`; match the class, or its message.
    if (err instanceof EncryptedPDFError || /encrypted/i.test(String(err && err.message))) {
      throw refuse('Password-protected or encrypted PDFs can\'t be used', 'PDF_ENCRYPTED');
    }
    throw refuse('The PDF could not be read', 'PDF_MALFORMED');
  }
  // The throw alone isn't a refusal: pdf-lib's parser runs with
  // `throwOnInvalidObject: false`, so a budget throw from inside its object
  // loop is logged and that object skipped — the load then "succeeds" with
  // the bomb quietly dropped, having already cost the budget in memory.
  // Checked outside the catch above so the refusal keeps its own code.
  if (meter.tripped()) {
    meter.restore();
    throw tooComplex();
  }

  let pages;
  let normalised;
  try {
    const active = findActiveContent(pdf);
    if (active) {
      throw refuse('PDFs with scripts, actions, forms or embedded files can\'t be used', 'PDF_ACTIVE_CONTENT');
    }

    pages = pdf.getPageCount();
    if (pages === 0) throw refuse('The PDF has no pages', 'PDF_EMPTY');
    if (pages > maxPages) throw refuse(`The PDF has more than ${maxPages} pages`, 'PDF_TOO_MANY_PAGES');

    // Only the objects this scan walked reach the stored file. Object streams
    // stay off so a re-read of the stored file scans the same flat objects.
    try {
      normalised = Buffer.from(await pdf.save({ useObjectStreams: false }));
    } catch (err) {
      if (err instanceof decodeBudget.DecodeBudgetExceeded) throw tooComplex();
      throw refuse('The PDF could not be read', 'PDF_MALFORMED');
    }
    // Saving decodes whatever the load left lazy, and swallows a throw the
    // same way. Belt and braces, and untested on its own: pdf-lib decodes
    // object streams on load, and `useObjectStreams: false` copies the other
    // streams raw, so on every fixture we have the after-load check above
    // trips first. It stays for a stream pdf-lib decodes lazily in a future
    // version.
    if (meter.tripped()) throw tooComplex();
  } catch (err) {
    if (err instanceof decodeBudget.DecodeBudgetExceeded) throw tooComplex();
    throw err;
  } finally {
    meter.restore();
  }
  if (normalised.length > maxBytes) {
    throw refuse(`The PDF is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`, 'PDF_TOO_LARGE');
  }

  return {
    pages,
    bytes: normalised.length,
    sha256: crypto.createHash('sha256').update(normalised).digest('hex'),
    normalised,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_INFLATE_BYTES,
  inspectPdf,
  _internal: { hasPdfSignature, findActiveContent, assertInflateWithinBudget },
};
