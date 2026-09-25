/**
 * A download keeps the photo's EXIF, XMP and IPTC (issue 1649).
 *
 * The stored original is never re-encoded, and the default download standard
 * is "original", so a stock install already ships the file with its metadata.
 * The two download paths that DO re-encode — the resize to the gallery's
 * standard or a picked resolution, and the watermark — went through sharp
 * without keepMetadata(), and sharp strips everything by default. A guest who
 * downloaded from a capped or watermarked gallery lost the photographer's
 * Artist and Copyright with it.
 *
 * Thumbnails, previews and heroes are NOT covered here: they stay stripped on
 * purpose (privacy — GPS), see withMetadata(false) in imageProcessor.
 */
const sharp = require('sharp');
const exifr = require('exifr');

jest.mock('../../src/database/db', () => {
  const api = (table) => {
    if (table === 'app_settings') {
      return { where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] };
    }
    return { where: () => ({ first: async () => null }) };
  };
  return { db: api };
});

const { resizeToBox } = require('../../src/services/imageProcessor');
const watermarkService = require('../../src/services/watermarkService');

const ARTIST = 'Nikos Photographer';
const COPYRIGHT = '(c) 2026 Nikos Photographer';
const XMP = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
  + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>'
  + ARTIST + '</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

/** A JPEG the way a camera or Lightroom leaves it: EXIF credit, XMP, optional orientation tag. */
const tagged = (width, height, { orientation, format = 'jpeg' } = {}) => {
  let image = sharp({ create: { width, height, channels: 3, background: { r: 30, g: 80, b: 140 } } });
  image = format === 'png' ? image.png() : format === 'webp' ? image.webp() : image.jpeg();
  return image
    .withMetadata({ exif: { IFD0: { Artist: ARTIST, Copyright: COPYRIGHT } }, ...(orientation ? { orientation } : {}) })
    .withXmp(XMP)
    .toBuffer();
};

const readTags = async (buffer) => {
  const meta = await exifr.parse(buffer, { tiff: true, ifd0: true, xmp: true, exif: false, gps: false }).catch(() => null);
  return meta ? { artist: meta.Artist, copyright: meta.Copyright, creator: meta.creator } : null;
};

const watermark = {
  enabled: true, position: 'bottom-right', opacity: 50, size: 15,
  // companyName, not text — the SVG branch reads this one.
  companyName: 'PicPeak',
};

describe('the source fixture', () => {
  test('carries the credit in EXIF and XMP', async () => {
    const tags = await readTags(await tagged(400, 300));
    expect(tags).toMatchObject({ artist: ARTIST, copyright: COPYRIGHT });
    expect([].concat(tags.creator)).toContain(ARTIST);
  });
});

describe('a download resized to the gallery standard (issue 1649)', () => {
  test('keeps the EXIF credit and the XMP block', async () => {
    const out = await resizeToBox(await tagged(2000, 1500), { width: 800, height: 800 });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(800);
    const tags = await readTags(out);
    expect(tags).toMatchObject({ artist: ARTIST, copyright: COPYRIGHT });
    expect([].concat(tags.creator)).toContain(ARTIST);
  });

  test.each(['png', 'webp'])('keeps it in %s too', async (format) => {
    const out = await resizeToBox(await tagged(2000, 1500, { format }), { width: 800, height: 800 });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe(format);
    // exifr does not read WebP, so ask sharp for the raw EXIF block instead.
    expect(Buffer.isBuffer(meta.exif)).toBe(true);
    expect(meta.exif.toString('latin1')).toContain(ARTIST);
    expect(meta.exif.toString('latin1')).toContain(COPYRIGHT);
  });

  test('does not leave the orientation tag behind on the rotated pixels', async () => {
    // rotate() bakes the orientation into the pixels; a surviving tag 6 would
    // make the viewer rotate it a second time.
    const out = await resizeToBox(await tagged(2000, 1000, { orientation: 6 }), { width: 800, height: 800 });
    const meta = await sharp(out).metadata();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
    expect(meta.height).toBeGreaterThan(meta.width);
    expect(await readTags(out)).toMatchObject({ artist: ARTIST });
  });
});

describe('a watermarked download (issue 1649)', () => {
  test('keeps the EXIF credit and the XMP block', async () => {
    const out = await watermarkService.applyWatermark(await tagged(1200, 800), watermark);
    expect(Buffer.isBuffer(out)).toBe(true);
    const tags = await readTags(out);
    expect(tags).toMatchObject({ artist: ARTIST, copyright: COPYRIGHT });
    expect([].concat(tags.creator)).toContain(ARTIST);
  });

  test('does not leave the orientation tag behind on the rotated pixels', async () => {
    const out = await watermarkService.applyWatermark(await tagged(1200, 600, { orientation: 6 }), watermark);
    const meta = await sharp(out).metadata();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
    expect(meta.height).toBeGreaterThan(meta.width);
  });
});
