/**
 * Regression test for #1024: quote/invoice PDF endpoints 500'd (or silently
 * corrupted the filename) for customers whose name carries non-ASCII.
 *
 * The six PDF routes built the header by interpolating buildPdfFilename()'s
 * result straight into `inline; filename="${filename}"`. HTTP header values
 * are latin1, which splits the failure in two — and the split matters,
 * because the issue reported the umlaut case as the 500 and it isn't:
 *
 *   U+0080-U+00FF  (ä ö ü ß — every German umlaut)
 *       No throw. The byte goes out raw and the client reads back a mangled
 *       name. A silent corruption, not an error.
 *
 *   above U+00FF   (Polish ł, Czech ř, Turkish ş, €, Cyrillic, CJK, emoji)
 *       Node's setHeader rejects it with ERR_INVALID_CHAR. Because the
 *       throw lands after the PDF buffer is already rendered, the whole
 *       request fails as an unhandled 500.
 *
 * buildContentDisposition() fixes both: an ASCII fallback for the legacy
 * `filename=` parameter plus the RFC 5987 `filename*=UTF-8''…` form that
 * carries the real name.
 *
 * These assertions run against the real Node header validator via a live
 * express server, so they'd fail against the old interpolation rather than
 * merely testing the helper in isolation.
 */
const express = require('express');
const request = require('supertest');

const { buildPdfFilename, sanitiseSegment } = require('../../src/utils/pdfFilename');
const { buildContentDisposition } = require('../../src/utils/filenameSanitizer');

// The RFC 5987 parameter prefix, i.e. filename*=UTF-8'' — the two trailing
// quotes are the (empty) language tag the spec puts between the charset and
// the percent-encoded value.
const RFC5987_PREFIX = 'filename*=UTF-8\'\'';

// Mirrors what the six PDF routes now do.
function buildApp(customer, docNumber = 'Q-2026-0042') {
  const app = express();
  app.get('/pdf', (req, res) => {
    const filename = buildPdfFilename({ docNumber, customer, fallback: 'quote-preview' });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', buildContentDisposition(filename, 'inline'));
    res.send(Buffer.from('%PDF-1.4 fake'));
  });
  // Mirrors the real error handler: an ERR_INVALID_CHAR throw inside the
  // handler surfaces as a 500, which is what #1024 reported.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.code || err.message }));
  return app;
}

describe('#1024 — PDF Content-Disposition with non-ASCII customer names', () => {
  it('serves a PDF for a German umlaut name and keeps the name intact', async () => {
    const res = await request(buildApp({ company_name: 'Müller Fotografie' })).get('/pdf');

    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'];
    // RFC 5987 form carries the real, unmangled name...
    expect(cd).toContain(RFC5987_PREFIX);
    expect(cd).toContain(encodeURIComponent('Müller-Fotografie.pdf'));
    // ...and the ASCII fallback is legal latin1 with no raw umlaut byte.
    const fallback = /filename="([^"]+)"/.exec(cd)[1];
    expect(fallback).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each([
    ['Polish',   'Michał Kowalski'],
    ['Czech',    'Dvořák Studio'],
    ['Turkish',  'Şahin Fotoğraf'],
    ['Cyrillic', 'Иванов Фото'],
    ['CJK',      '山田写真'],
    ['emoji',    'Studio 🎉 Berlin'],
  ])('does not 500 for a %s customer name (was ERR_INVALID_CHAR)', async (_label, company) => {
    const res = await request(buildApp({ company_name: company })).get('/pdf');

    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).toContain(RFC5987_PREFIX);
    // The legacy filename= token drops non-ASCII, so a name written entirely
    // in another script degrades to just the document number
    // (`Q-2026-0042_.pdf`). That's the intended trade — filename* carries the
    // real name — but the fallback must still be a legal, non-empty,
    // ASCII-only token, since that is what a client without RFC 5987 support
    // ends up saving.
    const fallback = /filename="([^"]*)"/.exec(cd)[1];
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toMatch(/^[\x20-\x7e]+$/);
    expect(fallback).toContain('Q-2026-0042');
  });

  it('leaves a plain ASCII name on the familiar filename= form', async () => {
    const res = await request(buildApp({ company_name: 'Bright Studio' })).get('/pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition'])
      .toContain('filename="Q-2026-0042_Bright-Studio.pdf"');
  });

  it('still works when the customer row is missing entirely (preview path)', async () => {
    const res = await request(buildApp(null, null)).get('/pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('quote-preview_customer.pdf');
  });

  // sanitiseSegment caps each segment at 80 UTF-16 code units. A cap landing
  // inside an astral character used to leave a dangling high surrogate, which
  // makes encodeURIComponent throw URIError inside buildContentDisposition —
  // a 500 on the very endpoint this PR fixes, reached a different way.
  it.each([
    ['emoji on the 80-char boundary',      `${'a'.repeat(79)}🎉`],
    ['astral CJK on the boundary',         `${'a'.repeat(79)}𠜎`],
    ['a label that is entirely astral',    '🎉'.repeat(60)],
  ])('does not 500 when truncation splits a surrogate pair — %s', async (_label, company) => {
    const res = await request(buildApp({ company_name: company })).get('/pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(RFC5987_PREFIX);
  });

  it('drops the orphaned surrogate rather than widening the length cap', () => {
    const seg = sanitiseSegment(`${'a'.repeat(79)}🎉`);

    // 79 'a's + a half-emoji would be 80; the orphan is dropped, not kept.
    expect(seg).toHaveLength(79);
    expect(seg).toBe('a'.repeat(79));
    // Nothing in the result may be an unpaired surrogate.
    expect(seg).toBe(seg.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, ''));
  });

  it('the raw interpolation these routes used to do really does throw', () => {
    // Pins the root cause itself, so nobody "simplifies" the helper away.
    const filename = buildPdfFilename({
      docNumber: 'Q-2026-0042',
      customer: { company_name: 'Michał Kowalski' },
    });
    const res = new (require('http').ServerResponse)({});
    expect(() => res.setHeader('Content-Disposition', `inline; filename="${filename}"`))
      .toThrow(/ERR_INVALID_CHAR|Invalid character/);
  });
});
