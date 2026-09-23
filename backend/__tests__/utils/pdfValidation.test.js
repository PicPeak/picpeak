/**
 * PDF content checks (#1445 attachments): a file is judged by its bytes.
 */

const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const { validatePdf } = require('../../src/utils/pdfValidation');

async function makePdf({ pages = 1, mutate } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 200]);
  if (mutate) await mutate(doc);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function codeOf(promise) {
  try { await promise; return null; } catch (err) { return err.code; }
}

const addAnnotation = (doc, action) => {
  const page = doc.getPage(0);
  const annot = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], A: action,
  }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
};

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const MB = 1024 * 1024;

test('a plain PDF passes and is described', async () => {
  const buffer = await makePdf({ pages: 3 });
  const info = await validatePdf(buffer);
  expect(info.pages).toBe(3);
  // bytes and sha256 describe the bytes the caller is meant to store: what
  // was checked, not the upload.
  expect(info.bytes).toBe(info.normalised.length);
  expect(info.sha256).toBe(crypto.createHash('sha256').update(info.normalised).digest('hex'));
});

// One page whose single FlateDecode stream inflates to `mb` megabytes of
// zeros — the shape a decompression bomb actually has. A few hundred KB of
// upload; the damage is all on the other side of the inflate.
function bomb(mb) {
  const payload = zlib.deflateSync(Buffer.alloc(mb * 1024 * 1024), { level: 9 });
  const head = Buffer.from([
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Contents 4 0 R>> endobj',
    `4 0 obj <</Length ${payload.length}/Filter/FlateDecode>>`,
    'stream\n',
  ].join('\n'), 'latin1');
  const tail = Buffer.from('\nendstream endobj\ntrailer <</Size 5/Root 1 0 R>>\n%%EOF', 'latin1');
  return Buffer.concat([head, payload, tail]);
}

test('a file that expands far past its size is refused before it is parsed', async () => {
  // 64 MB of inflate from ~64 KB of upload. The real budget is 256 MB, so
  // the same file passes with the default and is refused against a small one:
  // what is pinned is that the cap is on the EXPANDED size, and that it is
  // applied before pdf-lib inflates anything into memory a heap limit can't
  // reach.
  const file = bomb(64);
  expect(file.length).toBeLessThan(1024 * 1024);

  expect(await codeOf(validatePdf(file, { maxInflateBytes: 8 * 1024 * 1024 })))
    .toBe('PDF_TOO_COMPLEX');
  // The refusal costs no more than the budget: the check stops inflating at
  // it rather than after the file's own expansion.
  const before = process.memoryUsage().rss;
  await codeOf(validatePdf(file, { maxInflateBytes: 8 * 1024 * 1024 }));
  expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);

  // An ordinary document is nowhere near the budget.
  await expect(validatePdf(await makePdf({ pages: 3 }))).resolves.toEqual(
    expect.objectContaining({ pages: 3 }));
});

// One deflate stream whose COMPRESSED bytes carry the literal `endstream`
// keyword — a stored block, then the compressed payload, in a single stream.
// A guard that cuts at the keyword inflates a truncated prefix, charges it as
// damaged, and lets the rest through to the parser, which reads /Length and
// inflates all of it.
function poisonedStream(mb) {
  return new Promise((resolve) => {
    const chunks = [];
    const deflate = zlib.createDeflate({ level: 0 });
    deflate.on('data', (chunk) => chunks.push(chunk));
    deflate.on('end', () => resolve(Buffer.concat(chunks)));
    deflate.write(Buffer.from('\nendstream endobj\n'));
    deflate.flush(zlib.constants.Z_FULL_FLUSH, () => {
      deflate.params(9, zlib.constants.Z_DEFAULT_STRATEGY, () => {
        deflate.end(Buffer.alloc(mb * 1024 * 1024));
      });
    });
  });
}

test('a stream that carries the endstream keyword is still charged in full', async () => {
  const body = await poisonedStream(64);
  expect(body.includes(Buffer.from('endstream'))).toBe(true);
  const head = Buffer.from([
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Contents 4 0 R>> endobj',
    `4 0 obj <</Length ${body.length}/Filter/FlateDecode>>`,
    'stream\n',
  ].join('\n'), 'latin1');
  const file = Buffer.concat([head, body, Buffer.from('\nendstream endobj\ntrailer <</Size 5/Root 1 0 R>>\n%%EOF', 'latin1')]);

  // Where the stream ends is the parser's business, not the guard's: each
  // stream is inflated from its start and zlib stops at the end of the
  // deflate data, so the budget sees at least what the parser will.
  expect(await codeOf(validatePdf(file, { maxInflateBytes: 8 * 1024 * 1024 }))).toBe('PDF_TOO_COMPLEX');
});

// The maintainer's own fixture (#1464 round 5): 40 MB of zeros behind
// `/Filter [/ASCIIHexDecode /FlateDecode]` in an object stream, with a real
// xref so pdf-lib reaches the object. The raw-bytes pass can't see the
// expansion — the bytes it looks at are hex text, which only shrinks — so
// this is the case the decode meter exists for.
function hexFlateObjStm(mb) {
  const plain = Buffer.concat([Buffer.from('4 0 <<>>\n'), Buffer.alloc(mb * 1024 * 1024)]);
  const data = Buffer.from(`${zlib.deflateSync(plain, { level: 9 }).toString('hex')}>`);
  const parts = [];
  const offsets = [];
  const push = (part) => parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1'));
  const len = () => parts.reduce((n, part) => n + part.length, 0);
  push('%PDF-1.7\n');
  offsets[1] = len(); push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = len(); push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets[3] = len(); push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n');
  offsets[5] = len();
  push(`5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${data.length} >>\nstream\n`);
  push(data);
  push('\nendstream\nendobj\n');
  const xref = len();
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) {
    table += i === 4 ? '0000000000 65535 f \n' : `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(`${table}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

test('a filter chain the raw scan cannot read is refused, not silently skipped', async () => {
  const file = hexFlateObjStm(40);
  expect(file.length).toBeLessThan(200 * 1024);

  // pdf-lib parses with `throwOnInvalidObject: false`, so the budget's throw
  // from inside its object loop is logged and the object skipped — the load
  // "succeeds" with the bomb dropped, after paying for it. The meter
  // remembers, and the check refuses.
  expect(await codeOf(validatePdf(file, { maxInflateBytes: 16 * MB }))).toBe('PDF_TOO_COMPLEX');
});

test('a parse that outgrows its heap is a refusal, not a dead process', async () => {
  // pdf-lib inflates object streams on load and the upload cap is on the
  // compressed bytes, so a small crafted file can expand into gigabytes. The
  // parse runs in a worker with a heap limit; here the limit is tiny so the
  // same path is exercised by an ordinary file.
  const buffer = await makePdf({ pages: 40 });
  expect(await codeOf(validatePdf(buffer, { heapMb: 4 }))).toBe('PDF_TOO_COMPLEX');
  // …and the process is fine: the next check still answers.
  await expect(validatePdf(buffer)).resolves.toEqual(expect.objectContaining({ pages: 40 }));
});

test('an object defined twice cannot smuggle an action past the scan', async () => {
  // pdf-lib keeps the LAST definition of an object number; a viewer resolves
  // through the xref table, which can point at the first. So the scan sees
  // the harmless /GoTo while the file on disk would have offered the viewer
  // /JavaScript. What is stored is what was checked, so the JavaScript
  // object is not in it.
  const body = [
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R/OpenAction 5 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>> endobj',
    '5 0 obj <</S/JavaScript/JS(app.alert\\(1\\))>> endobj',
    '5 0 obj <</S/GoTo/D[3 0 R /Fit]>> endobj',
    'trailer <</Size 6/Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  const info = await validatePdf(Buffer.from(body, 'latin1'));
  const stored = info.normalised.toString('latin1');
  expect(stored).not.toContain('/JavaScript');
  expect(stored).not.toContain('app.alert');
  // And the stored file passes the scan on its own terms.
  await expect(validatePdf(info.normalised)).resolves.toEqual(expect.objectContaining({ pages: 1 }));
});

test('a web link is not active content', async () => {
  const buffer = await makePdf({
    mutate: (doc) => addAnnotation(doc, { S: 'URI', URI: PDFString.of('https://example.com') }),
  });
  await expect(validatePdf(buffer)).resolves.toEqual(expect.objectContaining({ pages: 1 }));
});

test('an OpenAction that is only a destination is fine', async () => {
  const buffer = await makePdf({
    mutate: (doc) => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj([doc.getPage(0).ref, PDFName.of('Fit')])),
  });
  await expect(validatePdf(buffer)).resolves.toEqual(expect.objectContaining({ pages: 1 }));
});

test('a file that is not a PDF is refused, whatever its name', async () => {
  expect(await codeOf(validatePdf(Buffer.from('hello, I am a text file')))).toBe('PDF_NOT_A_PDF');
  expect(await codeOf(validatePdf(Buffer.alloc(0)))).toBe('PDF_NOT_A_PDF');
});

test('a truncated PDF is refused', async () => {
  const buffer = (await makePdf()).subarray(0, 60);
  expect(['PDF_MALFORMED', 'PDF_EMPTY']).toContain(await codeOf(validatePdf(buffer)));
});

test('an encrypted PDF is refused', async () => {
  const plain = (await makePdf()).toString('latin1');
  const encrypted = Buffer.from(plain.replace('/Root', '/Encrypt 1 0 R\n/Root'), 'latin1');
  expect(await codeOf(validatePdf(encrypted))).toBe('PDF_ENCRYPTED');
});

test.each([
  ['JavaScript on open', (doc) => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({
    Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert(1)'),
  }))],
  ['a page action', (doc) => doc.getPage(0).node.set(PDFName.of('AA'), doc.context.obj({
    O: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') },
  }))],
  ['a launch action', (doc) => addAnnotation(doc, { S: 'Launch', F: PDFString.of('calc.exe') })],
  ['a form submission', (doc) => addAnnotation(doc, { S: 'SubmitForm', F: PDFString.of('https://example.com') })],
  ['an embedded file', (doc) => doc.attach(Buffer.from('payload'), 'payload.txt', { mimeType: 'text/plain' })],
  ['an XFA form', (doc) => doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({
    Fields: [], XFA: PDFString.of('<xdp:xdp/>'),
  }))],
])('refuses %s', async (_label, mutate) => {
  const buffer = await makePdf({ mutate });
  expect(await codeOf(validatePdf(buffer))).toBe('PDF_ACTIVE_CONTENT');
});

test('the size and page caps apply', async () => {
  const buffer = await makePdf({ pages: 3 });
  expect(await codeOf(validatePdf(buffer, { maxPages: 2 }))).toBe('PDF_TOO_MANY_PAGES');
  expect(await codeOf(validatePdf(buffer, { maxBytes: 100 }))).toBe('PDF_TOO_LARGE');
});

describe('pdfValidation without a worker', () => {
  afterEach(() => {
    jest.dontMock('worker_threads');
    jest.dontMock('../../src/utils/pdfInspect');
    jest.resetModules();
  });

  it('refuses rather than inspecting in the main thread', async () => {
    const buffer = await makePdf();
    jest.resetModules();
    jest.doMock('worker_threads', () => ({ Worker: function NoWorker() { throw new Error('no workers here'); } }));
    const actual = jest.requireActual('../../src/utils/pdfInspect');
    const inspect = jest.fn();
    jest.doMock('../../src/utils/pdfInspect', () => ({ ...actual, inspectPdf: inspect }));
    const { validatePdf: isolated } = require('../../src/utils/pdfValidation');
    const err = await isolated(buffer).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('DOCUMENT_CHECK_UNAVAILABLE');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('reaches a customer upload as DOCUMENT_CHECK_UNAVAILABLE, not as active content', async () => {
    const file = path.join(os.tmpdir(), `pdf-no-worker-${process.pid}.pdf`);
    fs.writeFileSync(file, await makePdf());
    jest.resetModules();
    jest.doMock('worker_threads', () => ({ Worker: function NoWorker() { throw new Error('no workers here'); } }));
    const { _internal: { assertPdf } } = require('../../src/services/customerDocumentsService');
    try {
      const err = await assertPdf(file).catch((e) => e);
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('DOCUMENT_CHECK_UNAVAILABLE');
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('pdfValidation wait queue', () => {
  afterEach(() => {
    jest.dontMock('worker_threads');
    jest.resetModules();
  });

  it('refuses with 503 once MAX_WAITING checks are queued behind the running ones', async () => {
    const buffer = await makePdf();
    jest.resetModules();
    const workers = [];
    const { EventEmitter } = require('events');
    jest.doMock('worker_threads', () => ({
      Worker: class FakeWorker extends EventEmitter {
        constructor() { super(); workers.push(this); }
        terminate() { return Promise.resolve(); }
      },
    }));
    const { MAX_CONCURRENT, MAX_WAITING, validatePdf: queued } = require('../../src/utils/pdfValidation');
    const accepted = Array.from({ length: MAX_CONCURRENT + MAX_WAITING }, () => queued(buffer));
    const err = await queued(buffer).catch((e) => e);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('DOCUMENT_CHECK_UNAVAILABLE');
    // Drain: every queued check still gets its turn.
    const info = { pages: 1, bytes: 1, sha256: 'x', normalised: new Uint8Array(1) };
    let done = 0;
    accepted.forEach((p) => p.then(() => { done += 1; }));
    while (done < accepted.length) {
      workers.splice(0).forEach((w) => w.emit('message', { ok: true, info }));
      await new Promise((r) => setImmediate(r));
    }
    expect(done).toBe(MAX_CONCURRENT + MAX_WAITING);
  });
});
