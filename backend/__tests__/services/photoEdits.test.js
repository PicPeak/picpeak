/**
 * Non-destructive photo edits (issue 2619), through the real service, real
 * sharp (in the image worker) and SQLite.
 *
 * Pins:
 *  - golden: the stored edited render matches a CPU reference built from the
 *    formulas in photoEditMath (not its lookup tables), within JPEG noise
 *  - the original file is never touched
 *  - saving queues the photo; a pass renders, rebuilds the thumbnail and
 *    preview from the edit and marks the revision applied; a restart (a new
 *    pass over the same rows) resumes
 *  - a render of a revision a newer save superseded is not recorded and its
 *    file is dropped
 *  - a reset brings the original back and removes the render
 *  - deliveredPhoto names the render as a JPEG; resolvePhotoStorageKey honours
 *    it, and refuses a marker that names anything else
 *  - a manual focal point follows a rotation
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-edits-')), 'db.sqlite');
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-edits-storage-'));
process.env.EXTERNAL_MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-edits-external-'));

const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const math = require('../../src/utils/photoEditMath');

jest.setTimeout(120000);

// Metadata goes onto an edited render through exiftool (an allowlist): the
// CI installs it; elsewhere these run where it is on PATH.
const HAVE_EXIFTOOL = !require('child_process').spawnSync('exiftool', ['-ver'], { stdio: 'ignore' }).error;
const itExif = HAVE_EXIFTOOL || process.env.PICPEAK_REQUIRE_DCRAW === 'true' ? it : it.skip;
const describeExif = HAVE_EXIFTOOL || process.env.PICPEAK_REQUIRE_DCRAW === 'true' ? describe : describe.skip;


let db; let cleanup; let eventId; let photoId; let originalBytes;
const storagePath = (key) => path.join(process.env.STORAGE_PATH, key);
const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
const row = () => db('photos').where({ id: photoId }).first();

/** A 600x400 test card: colour gradients, a grey ramp and a dark corner. */
async function testCard() {
  const width = 600;
  const height = 400;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (y < 80) {
        const v = Math.round((x / (width - 1)) * 255);
        data[o] = v; data[o + 1] = v; data[o + 2] = v;
      } else {
        data[o] = Math.round((x / width) * 220 + 20);
        data[o + 1] = Math.round((y / height) * 200 + 30);
        data[o + 2] = Math.round(((x + y) % 200) / 200 * 180 + 40);
      }
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** The CPU reference: the decoded original, the inverse map, bilinear, then the formula pipeline. */
async function reference(originalJpeg, params) {
  const { data, info } = await sharp(originalJpeg).rotate().raw().toBuffer({ resolveWithObject: true });
  const out = math.outputSize(params, info.width, info.height);
  const map = math.inverseMapper(params, info.width, info.height, out);
  const result = new Float64Array(out.width * out.height * 3);
  const px = [0, 0, 0];
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const p = map(x + 0.5, y + 0.5);
      const fx = Math.min(info.width - 1, Math.max(0, p.x - 0.5));
      const fy = Math.min(info.height - 1, Math.max(0, p.y - 0.5));
      const x0 = Math.floor(fx); const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, info.width - 1); const y1 = Math.min(y0 + 1, info.height - 1);
      for (let c = 0; c < 3; c++) {
        const at = (xx, yy) => data[(yy * info.width + xx) * 3 + c];
        const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (fx - x0);
        const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (fx - x0);
        px[c] = Math.round(top + (bottom - top) * (fy - y0)) / 255;
      }
      const v = math.referencePixel(px, params);
      result.set(v.map((c) => c * 255), (y * out.width + x) * 3);
    }
  }
  return { data: result, width: out.width, height: out.height };
}

async function compare(key, ref) {
  const { data, info } = await sharp(fs.readFileSync(storagePath(key))).raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([ref.width, ref.height]);
  let sum = 0;
  const diffs = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) {
    diffs[i] = Math.abs(data[i] - ref.data[i]);
    sum += diffs[i];
  }
  diffs.sort();
  return { mean: sum / data.length, p999: diffs[Math.floor(diffs.length * 0.999)], max: diffs[diffs.length - 1] };
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  eventId = unwrap(await db('events').insert({
    slug: 'edit-card', event_type: 'wedding', event_name: 'Edit card', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_token: 'tok-edit-card', share_link: '/gallery/edit-card/tok-edit-card',
    created_by: adminId, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
  }).returning('id'));
  const dir = storagePath('events/active/edit-card');
  fs.mkdirSync(dir, { recursive: true });
  originalBytes = await testCard();
  fs.writeFileSync(path.join(dir, 'card.jpg'), originalBytes);
  photoId = unwrap(await db('photos').insert({
    event_id: eventId, filename: 'card.jpg', original_filename: 'IMG_0001.JPEG', path: 'edit-card/card.jpg',
    type: 'individual', media_type: 'image', mime_type: 'image/jpeg', width: 600, height: 400,
    size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(),
  }).returning('id'));
  const { ensureThumbnail, ensurePreviewImage } = require('../../src/services/imageProcessor');
  await ensureThumbnail(await row(), { force: true });
  await ensurePreviewImage(await row(), { force: true });
}, 120000);

afterAll(async () => {
  await require('../../src/services/isolatedSharp').shutdown();
  if (cleanup) await cleanup();
});

const photoEdits = () => require('../../src/services/photoEdits');
const validated = (input) => {
  const { params, error } = math.validateEditParams(input);
  if (error) throw new Error(error);
  return params;
};

describe('the edited render (golden, server vs CPU reference)', () => {
  const cases = {
    tone: { exposure: 0.6, contrast: 30, highlights: -40, shadows: 35, whites: 10, blacks: -15 },
    colour: { temperature: 40, tint: -20, vibrance: 50, saturation: -30 },
    geometry: { rotate: 90, flipH: true, straighten: 4.5, crop: { x: 0.1, y: 0.05, w: 0.8, h: 0.7 }, exposure: -0.4 },
    blackWhite: { bw: true, contrast: 20 },
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`matches the reference within JPEG noise: ${name}`, async () => {
      const params = validated(input);
      const photo = { ...(await row()), edit_params: math.canonicalJson(params), edit_rev: 1 };
      const { buffer } = await photoEdits().renderEditedJpeg(photo, params);
      const key = `edits/golden-${name}.jpg`;
      fs.mkdirSync(path.dirname(storagePath(key)), { recursive: true });
      fs.writeFileSync(storagePath(key), buffer);
      const { mean, p999, max } = await compare(key, await reference(originalBytes, params));
      // q92 4:4:4 JPEG: under a level on average; the worst pixels are the
      // encoder's ringing along the card's one hard edge.
      expect(mean).toBeLessThan(1.5);
      expect(p999).toBeLessThan(16);
      expect(max).toBeLessThan(64);
    });
  }

  itExif('carries the source EXIF with the orientation upright', async () => {
    const params = validated({ exposure: 0.3 });
    const exifSource = await sharp(originalBytes).withExif({ IFD0: { Copyright: 'Studio test', Orientation: '1' } }).jpeg().toBuffer();
    const file = storagePath('events/active/edit-card/exif.jpg');
    fs.writeFileSync(file, exifSource);
    const photo = { ...(await row()), path: 'edit-card/exif.jpg', edit_rev: 1 };
    const { buffer } = await photoEdits().renderEditedJpeg(photo, params);
    const meta = await sharp(buffer).metadata();
    expect(meta.exif.toString('latin1')).toContain('Studio test');
  });
});

describe('a JPEG named like a camera RAW', () => {
  it('is never sent to LibRaw, whatever its name says', async () => {
    const rawDevelop = require('../../src/services/rawDevelop');
    const available = jest.spyOn(rawDevelop, 'isAvailable').mockResolvedValue(true);
    const develop = jest.spyOn(rawDevelop, 'developLinear').mockRejectedValue(new Error('sent to LibRaw'));
    try {
      const photo = { ...(await row()), filename: 'card.CR3', original_filename: 'IMG_0001.CR3', edit_rev: 1 };
      const { width, height } = await photoEdits().renderEditedJpeg(photo, validated({ exposure: 0.2 }));
      expect([width, height]).toEqual([600, 400]);
      expect(develop).not.toHaveBeenCalled();
      expect(await rawDevelop.isRawSource(photo)).toBe(false);
    } finally {
      available.mockRestore();
      develop.mockRestore();
    }
  });
});

describeExif('embedded images of the source', () => {
  /** An EXIF block (little-endian TIFF) with a camera name in IFD0 and `thumb` as the IFD1 thumbnail. */
  const exifWithThumbnail = (thumb) => {
    const make = Buffer.from('Leakcam\0', 'latin1');
    const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 24 + 4);
    tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
    let at = 8;
    tiff.writeUInt16LE(1, at); at += 2;
    const makeOffset = tiff.length;
    tiff.writeUInt16LE(0x010f, at); tiff.writeUInt16LE(2, at + 2); tiff.writeUInt32LE(make.length, at + 4); tiff.writeUInt32LE(makeOffset, at + 8); at += 12;
    tiff.writeUInt32LE(at + 4, at); at += 4; // next IFD: IFD1 right after
    tiff.writeUInt16LE(2, at); at += 2;
    const thumbOffset = makeOffset + make.length;
    tiff.writeUInt16LE(0x0201, at); tiff.writeUInt16LE(4, at + 2); tiff.writeUInt32LE(1, at + 4); tiff.writeUInt32LE(thumbOffset, at + 8); at += 12;
    tiff.writeUInt16LE(0x0202, at); tiff.writeUInt16LE(4, at + 2); tiff.writeUInt32LE(1, at + 4); tiff.writeUInt32LE(thumb.length, at + 8); at += 12;
    tiff.writeUInt32LE(0, at);
    return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, make, thumb]);
  };

  it('an edited render carries no thumbnail or preview of the uncropped original', async () => {
    const thumb = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 250, g: 0, b: 250 } } }).jpeg().toBuffer();
    const xmp = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
      + '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/" xmp:CreatorTool="Studio">'
      + '<xmp:Thumbnails><rdf:Alt><rdf:li><xmpGImg:image>U0VDUkVUVEhVTUI=</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails>'
      + '</rdf:Description></rdf:RDF></x:xmpmeta>', 'utf8');
    const source = require('../../src/services/imageProcessor').withSourceMetadata(originalBytes, { exif: exifWithThumbnail(thumb), xmp });
    const file = storagePath('events/active/edit-card/thumbed.jpg');
    fs.writeFileSync(file, source);
    const photo = { ...(await row()), path: 'edit-card/thumbed.jpg', edit_rev: 1 };
    const { buffer } = await photoEdits().renderEditedJpeg(photo, validated({ crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }));
    expect(buffer.indexOf(thumb)).toBe(-1);
    expect(buffer.indexOf('U0VDUkVUVEhVTUI=')).toBe(-1);
    expect(await require('exifr').thumbnail(buffer)).toBeUndefined();
    // The camera stays; tags off the allowlist go.
    expect(buffer.indexOf('Leakcam')).toBeGreaterThan(-1);
    expect(buffer.indexOf('CreatorTool')).toBe(-1);
  });

  it('keeps only the allowlisted metadata: no face regions, people, keywords, embedded XMP images or maker notes', async () => {
    const exif = await sharp(originalBytes).withExif({
      IFD0: { Artist: 'Ann Photographer', Copyright: '(c) Studio Ann', Make: 'Leakcam', Model: 'L1' },
      IFD2: { DateTimeOriginal: '2026:06:01 09:45:03', ISOSpeedRatings: '160', MakerNote: 'SECRETMAKERNOTE' },
    }).jpeg().toBuffer();
    const xmp = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
      + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:mwg-rs="http://www.metadataworkinggroup.com/schemas/regions/"'
      + ' xmlns:stArea="http://ns.adobe.com/xmp/sType/Area#" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"'
      + ' xmlns:GImage="http://ns.google.com/photos/1.0/image/" GImage:Mime="image/jpeg" GImage:Data="SECRETGIMAGEDATA">'
      + '<dc:creator><rdf:Seq><rdf:li>Ann Photographer</rdf:li></rdf:Seq></dc:creator>'
      + '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">All rights reserved</rdf:li></rdf:Alt></dc:rights>'
      + '<dc:subject><rdf:Bag><rdf:li>secretkeyword</rdf:li></rdf:Bag></dc:subject>'
      + '<Iptc4xmpExt:PersonInImage><rdf:Bag><rdf:li>Secret Person</rdf:li></rdf:Bag></Iptc4xmpExt:PersonInImage>'
      + '<mwg-rs:Regions rdf:parseType="Resource"><mwg-rs:RegionList><rdf:Bag><rdf:li rdf:parseType="Resource">'
      + '<mwg-rs:Name>Secret Face</mwg-rs:Name><mwg-rs:Type>Face</mwg-rs:Type></rdf:li></rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions>'
      + '</rdf:Description></rdf:RDF></x:xmpmeta>', 'utf8');
    const meta = await sharp(exif).metadata();
    const source = require('../../src/services/imageProcessor').withSourceMetadata(originalBytes, { exif: meta.exif, xmp });
    fs.writeFileSync(storagePath('events/active/edit-card/tagged.jpg'), source);
    const photo = { ...(await row()), path: 'edit-card/tagged.jpg', edit_rev: 1 };
    const { buffer } = await photoEdits().renderEditedJpeg(photo, validated({ exposure: 0.2 }));
    for (const secret of ['Secret Face', 'Secret Person', 'secretkeyword', 'SECRETGIMAGEDATA', 'SECRETMAKERNOTE', 'RegionList', 'PersonInImage']) {
      expect(buffer.indexOf(secret)).toBe(-1);
    }
    for (const kept of ['Ann Photographer', '(c) Studio Ann', 'All rights reserved', '2026:06:01 09:45:03', 'Leakcam']) {
      expect(buffer.indexOf(kept)).toBeGreaterThan(-1);
    }
  });
});

describe('save, background apply, reset', () => {
  it('queues the photo, renders the edit, rebuilds its renditions and never touches the original', async () => {
    const params = validated({ crop: { x: 0, y: 0, w: 0.5, h: 1 }, exposure: 1 });
    const before = await row();
    await photoEdits().saveEdits([{ photo: before, params }]);
    let current = await row();
    expect(current).toMatchObject({ edit_rev: 1, edit_applied_rev: 0, edit_width: 300, edit_height: 400 });
    expect(JSON.parse(current.edit_params)).toMatchObject({ exposure: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } });

    expect(await photoEdits().runPass({ active: () => true, sleep: async () => {} })).toMatchObject({ applied: 1, failed: 0 });
    current = await row();
    expect(current.edit_applied_rev).toBe(1);
    expect(current.edit_render_path).toMatch(new RegExp(`^edits/edit_p${photoId}_r1_s[0-9a-f]{10}_[0-9a-f]{12}\\.jpg$`));
    // The preview is cut from the half-width edit (the thumbnail is a square cover crop).
    expect(current.thumbnail_path).toContain(`edit_p${photoId}_r1_`);
    const preview = await sharp(storagePath(current.preview_path)).metadata();
    expect(preview.width / preview.height).toBeCloseTo(0.75, 1);
    expect(fs.readFileSync(storagePath('events/active/edit-card/card.jpg')).equals(originalBytes)).toBe(true);
  });

  it('is resumable: a pass picks up rows saved while nothing ran', async () => {
    const params = validated({ saturation: -100 });
    await photoEdits().saveEdits([{ photo: await row(), params }]);
    const renderBefore = (await row()).edit_render_path;
    expect((await row()).edit_applied_rev).toBe(1);
    // A fresh pass, as after a restart.
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    const current = await row();
    expect(current).toMatchObject({ edit_rev: 2, edit_applied_rev: 2 });
    expect(current.edit_render_path).toMatch(/_r2_/);
    // The superseded render is gone.
    expect(fs.existsSync(storagePath(renderBefore))).toBe(false);
    expect(photoEdits().hasFailed(current)).toBe(false);
  });

  it('does not record a render a newer save superseded, and drops its file', async () => {
    const stale = await row();
    await db('photos').where({ id: photoId }).update({ edit_rev: stale.edit_rev + 1 });
    const editsDir = storagePath('edits');
    const filesBefore = fs.readdirSync(editsDir).length;
    const key = await photoEdits().ensureEditedSource({ ...stale, edit_render_path: null });
    // Served the revision the row has now, never the stale one.
    expect(key).toMatch(new RegExp(`_r${stale.edit_rev + 1}_`));
    expect((await row()).edit_render_path).toBe(key);
    // The stale render is dropped. The applied revision's render stays while
    // the new one is pending (renditions are cut from it), and goes once the
    // new revision is applied.
    const applied = path.basename(stale.edit_applied_render_path);
    expect(fs.readdirSync(editsDir).filter((name) => name.includes(`_r${stale.edit_rev}_`) && name.startsWith('edit_'))).toEqual([applied]);
    expect(fs.readdirSync(editsDir).length).toBe(filesBefore + 1);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    expect(fs.existsSync(path.join(editsDir, applied))).toBe(false);
  });

  it('renders again when the source was rewritten in place (an external refresh)', async () => {
    const before = await row();
    const oldKey = await photoEdits().ensureEditedSource(before);
    // refreshChangedFile records the new size and mtime and keeps the edit.
    await db('photos').where({ id: photoId }).update({ size_bytes: before.size_bytes + 1, source_mtime_ms: 1767225600000 });
    const fresh = await photoEdits().ensureEditedSource(await row());
    expect(fresh).not.toBe(oldKey);
    expect((await row()).edit_render_path).toBe(fresh);
    expect(fs.existsSync(storagePath(oldKey))).toBe(false);
    expect(await photoEdits().ensureEditedSource(await row())).toBe(fresh);
  });

  it('delivers the render as a JPEG named like the photo, and the resolver refuses a foreign key', async () => {
    const { resolvePhotoStorageKey } = require('../../src/services/photoResolver');
    const event = await db('events').where({ id: eventId }).first();
    const delivered = await photoEdits().deliveredPhoto(await row());
    expect(delivered).toMatchObject({ mime_type: 'image/jpeg', filename: 'card.jpg', original_filename: 'IMG_0001.jpg', width: 600, height: 400 });
    expect(resolvePhotoStorageKey(event, delivered)).toBe((await row()).edit_render_path);
    expect(resolvePhotoStorageKey(event, await row())).toBe('events/active/edit-card/card.jpg');
    expect(() => resolvePhotoStorageKey(event, { ...delivered, edit_delivery_key: 'events/active/edit-card/card.jpg' })).toThrow(/Invalid edited render key/);
    expect(() => resolvePhotoStorageKey(event, { ...delivered, id: delivered.id + 1 })).toThrow(/Invalid edited render key/);
  });

  it('a reset brings the original back and removes the render', async () => {
    const render = (await row()).edit_render_path;
    await photoEdits().saveEdits([{ photo: await row(), params: null }]);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    const current = await row();
    expect(current).toMatchObject({ edit_params: null, edit_render_path: null, edit_width: null });
    expect(current.edit_applied_rev).toBe(current.edit_rev);
    expect(fs.existsSync(storagePath(render))).toBe(false);
    expect(current.thumbnail_path).not.toContain('edit_p');
    const preview = await sharp(storagePath(current.preview_path)).metadata();
    expect(preview.width / preview.height).toBeCloseTo(1.5, 1);
    expect(await photoEdits().deliveredPhoto(current)).toBe(current);
  });
});

describe('noise reduction on a sensor developed at half size', () => {
  it('still reaches LibRaw: a 60 MP RAW with NR gets the median passes the half-size develop takes', async () => {
    const rawDevelop = require('../../src/services/rawDevelop');
    const media = require('../../src/services/mediaProcessService');
    fs.copyFileSync(path.join(__dirname, '../fixtures/raw/synthetic.dng'), storagePath('events/active/edit-card/big.dng'));
    const photo = { ...(await row()), id: 999001, filename: 'big.dng', original_filename: 'BIG.DNG', path: 'edit-card/big.dng', mime_type: 'image/x-adobe-dng' };
    const spies = [
      jest.spyOn(rawDevelop, 'isAvailable').mockResolvedValue(true),
      jest.spyOn(rawDevelop, 'isOrdinaryImageFile').mockResolvedValue(false),
      // A 60 MP sensor: above 1.5 x PHOTO_EDIT_MAX_PIXELS, developed at half size.
      jest.spyOn(rawDevelop, 'identify').mockResolvedValue({ width: 9504, height: 6336, multipliers: null, exposureBias: 0 }),
    ];
    const run = jest.spyOn(media, 'run').mockRejectedValue(new Error('stop before LibRaw'));
    try {
      const args = async (nr) => {
        run.mockClear();
        await expect(photoEdits().renderEditedJpeg(photo, validated({ develop: true, nr }))).rejects.toThrow('stop before LibRaw');
        return run.mock.calls[0][1];
      };
      const without = await args(0);
      const withNr = await args(100);
      expect(without).toContain('-h');
      expect(withNr).toContain('-h');
      expect(withNr).toEqual(expect.arrayContaining(['-m', '3']));
      expect(without).not.toContain('-m');
    } finally {
      run.mockRestore();
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('an edit whose render failed', () => {
  it('is not rendered again on a request: 503 at once; the pass (and so an admin retry) tries it', async () => {
    fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath('events/active/edit-card/failed-once.jpg'));
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'failed-once.jpg', path: 'edit-card/failed-once.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const fresh = () => db('photos').where({ id }).first();
    try {
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ exposure: 0.4 }) }]);
      // The pass failed on it (the source has since become readable again).
      await db('photos').where({ id }).update({ edit_failed_rev: 1, edit_error: 'render' });
      await expect(photoEdits().ensureEditedSource(await fresh())).rejects.toMatchObject({ status: 503, code: 'EDIT_FAILED' });
      expect((await fresh()).edit_render_path).toBeNull();
      await photoEdits().runPass({ active: () => true, sleep: async () => {} });
      expect(await fresh()).toMatchObject({ edit_applied_rev: 1, edit_failed_rev: null });
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});

describe('a failed edit of a photo with renditions', () => {
  it('is applied by the next pass, renditions and all', async () => {
    fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath('events/active/edit-card/recover.jpg'));
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'recover.jpg', path: 'edit-card/recover.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const fresh = () => db('photos').where({ id }).first();
    const { ensureThumbnail, ensurePreviewImage } = require('../../src/services/imageProcessor');
    try {
      await ensureThumbnail(await fresh(), { force: true });
      await ensurePreviewImage(await fresh(), { force: true });
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ exposure: 0.4 }) }]);
      // An earlier pass failed on it; the source is fine again.
      await db('photos').where({ id }).update({ edit_failed_rev: 1, edit_error: 'render' });
      expect(await photoEdits().runPass({ active: () => true, sleep: async () => {} })).toMatchObject({ failed: 0 });
      const after = await fresh();
      expect(after).toMatchObject({ edit_applied_rev: 1, edit_failed_rev: null });
      expect(after.thumbnail_path).toContain(`edit_p${id}_r1_`);
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});

describe('the renditions of a revision being applied', () => {
  it('are built beside the live ones, which change only when the revision is applied', async () => {
    fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath('events/active/edit-card/staged.jpg'));
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'staged.jpg', path: 'edit-card/staged.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const fresh = () => db('photos').where({ id }).first();
    const { ensurePreviewImage } = require('../../src/services/imageProcessor');
    const renditionRefresh = require('../../src/services/renditionRefresh');
    const refresh = renditionRefresh.refreshPhoto;
    let during = null;
    const spy = jest.spyOn(renditionRefresh, 'refreshPhoto').mockImplementation(async (...args) => {
      const ok = await refresh(...args);
      // What a request sees between building the new renditions and applying the revision.
      const row = await fresh();
      during = { row, meta: await sharp(storagePath(row.preview_path)).metadata() };
      return ok;
    });
    try {
      const before = await ensurePreviewImage(await fresh());
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ rotate: 90 }) }]);
      await photoEdits().runPass({ active: () => true, sleep: async () => {} });
      // Still the unturned preview, at revision 0, as the listing says.
      expect(during.row).toMatchObject({ preview_path: before, edit_applied_rev: 0 });
      expect(during.meta.width).toBeGreaterThan(during.meta.height);
      const after = await fresh();
      expect(after.edit_applied_rev).toBe(1);
      expect(after.preview_path).not.toBe(before);
      const meta = await sharp(storagePath(after.preview_path)).metadata();
      expect(meta.height).toBeGreaterThan(meta.width);
      // The old one goes once the new one is recorded.
      expect(fs.existsSync(storagePath(before))).toBe(false);
    } finally {
      spy.mockRestore();
      await db('photos').where({ id }).delete();
    }
  });
});

describe('a guest request while the pass applies a revision', () => {
  it('cannot leave the old revision\'s preview in place once the new one is applied', async () => {
    fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath('events/active/edit-card/race-preview.jpg'));
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'race-preview.jpg', path: 'edit-card/race-preview.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const fresh = () => db('photos').where({ id }).first();
    const imageProcessor = require('../../src/services/imageProcessor');
    const renditionRefresh = require('../../src/services/renditionRefresh');
    const refresh = renditionRefresh.refreshPhoto;
    let raced = false;
    const spy = jest.spyOn(renditionRefresh, 'refreshPhoto').mockImplementation(async (...args) => {
      const ok = await refresh(...args);
      if (!raced) {
        raced = true;
        // A guest holding the row as it was asks for its preview: it is cut
        // for the applied revision and recorded over the pass's new one.
        await db('photos').where({ id }).update({ preview_path: null });
        await imageProcessor.ensurePreviewImage(await fresh(), { force: true });
      }
      return ok;
    });
    try {
      await imageProcessor.ensurePreviewImage(await fresh());
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ rotate: 90 }) }]);
      await photoEdits().runPass({ active: () => true, sleep: async () => {} });
      const after = await fresh();
      expect(after.edit_applied_rev).toBe(1);
      const meta = await sharp(storagePath(after.preview_path)).metadata();
      // The turned picture, not the original the guest's request cut.
      expect(meta.height).toBeGreaterThan(meta.width);
    } finally {
      spy.mockRestore();
      await db('photos').where({ id }).delete();
    }
  });
});

describe('a guest\'s drawing on an edited photo', () => {
  it('is stored with the applied edit\'s geometry and shown on the photo as it is edited now', async () => {
    const feedbackService = require('../../src/services/feedbackService');
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'drawn.jpg', path: 'edit-card/card.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      width: 600, height: 400, size_bytes: 1, processing_status: 'complete', uploaded_at: new Date().toISOString(),
      edit_params: math.canonicalJson(validated({ rotate: 90 })), edit_rev: 1, edit_applied_rev: 1,
      edit_applied_params: math.canonicalJson(validated({ rotate: 90 })),
    }).returning('id'));
    try {
      // Drawn on the turned photo guests see.
      await feedbackService.submitFeedback(id, eventId, {
        feedback_type: 'comment', comment_text: 'look here', guest_name: 'Ann', annotation_rev: 1,
        annotation: { v: 1, strokes: [{ t: 'arrow', c: 0, p: [[0.8, 0.1], [0.5, 0.5]] }] },
      }, 'guest-ann');
      const stored = await db('photo_feedback').where({ photo_id: id }).first();
      expect(JSON.parse(stored.annotation_geometry)).toMatchObject({ rotate: 90 });
      // Drawn on a picture of another revision than the one applied now: refused, reload.
      expect(await feedbackService.submitFeedback(id, eventId, {
        feedback_type: 'comment', comment_text: 'stale', guest_name: 'Ann', annotation_rev: 0,
        annotation: { v: 1, strokes: [{ t: 'arrow', c: 0, p: [[0.1, 0.1], [0.5, 0.5]] }] },
      }, 'guest-ann')).toMatchObject({ image_changed: true });
      expect(await db('photo_feedback').where({ photo_id: id, comment_text: 'stale' }).first()).toBeUndefined();
      // Shown as drawn while the edit stands...
      let [shown] = await feedbackService.getPhotoFeedback(id, { feedback_type: 'comment' });
      expect(shown).toMatchObject({ annotation: { strokes: [{ p: [[0.8, 0.1], [0.5, 0.5]] }] }, annotation_clipped: false });
      expect(shown).not.toHaveProperty('annotation_geometry');
      // ...and on the original after a reset is applied.
      await db('photos').where({ id }).update({ edit_params: null, edit_rev: 2, edit_applied_rev: 2, edit_applied_params: null });
      [shown] = await feedbackService.getPhotoFeedback(id, { feedback_type: 'comment' });
      expect(shown.annotation.strokes[0].p).toEqual([[0.1, 0.2], [0.5, 0.5]]);
    } finally {
      await db('photo_feedback').where({ photo_id: id }).delete();
      await db('photos').where({ id }).delete();
    }
  });
});

describe('renditions while a newer edit is being applied', () => {
  it('show the applied revision, as its URL and face boxes do, until the pass applies the new one', async () => {
    fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath('events/active/edit-card/tier-pending.jpg'));
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'tier-pending.jpg', path: 'edit-card/tier-pending.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const fresh = () => db('photos').where({ id }).first();
    const imageProcessor = require('../../src/services/imageProcessor');
    const tierShape = async () => {
      const key = await imageProcessor.ensurePreviewImageAtWidth(await fresh(), 640);
      const meta = await sharp(storagePath(key)).metadata();
      return { key, ratio: Math.round((meta.width / meta.height) * 100) / 100 };
    };
    try {
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ rotate: 90 }) }]);
      await photoEdits().runPass({ active: () => true, sleep: async () => {} });
      // A crop saved, not applied yet: guests' URLs still name revision 1.
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ rotate: 90, crop: { x: 0, y: 0, w: 1, h: 0.5 } }) }]);
      const pending = await tierShape();
      expect(pending.ratio).toBeCloseTo(0.67, 1);
      expect(pending.key).toMatch(/_e1_/);
      // Nothing is kept under the old URL while a newer edit is pending.
      expect(photoEdits().editVersionStale(await fresh(), '1')).toBe(true);
      await photoEdits().runPass({ active: () => true, sleep: async () => {} });
      const applied = await tierShape();
      expect(applied.ratio).toBeCloseTo(1.33, 1);
      expect(applied.key).toMatch(/_e2_/);
      expect(photoEdits().editVersionStale(await fresh(), '2')).toBe(false);
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});

describe('auto develop of a guest upload held for review', () => {
  it('waits for the approval, and develops the RAW then', async () => {
    const { setFeatureFlags } = require('../integration/helpers/crmDb');
    const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
    const rawDevelop = require('../../src/services/rawDevelop');
    const isRaw = jest.spyOn(rawDevelop, 'isRawSource').mockResolvedValue(true);
    await setFeatureFlags(db, { photoEditor: true });
    invalidateFeatureFlagCache();
    await require('../../src/utils/appSettings').upsertAppSetting(photoEdits().AUTO_DEVELOP_SETTING, 'true', 'boolean');
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'held.cr3', path: 'edit-card/card.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/x-canon-cr3', width: 600, height: 400, size_bytes: 1, processing_status: 'complete',
      uploaded_at: new Date().toISOString(), visibility: 'hidden', moderation_status: 'pending',
    }).returning('id'));
    try {
      await photoEdits().afterUpload(id);
      expect((await db('photos').where({ id }).first()).edit_params).toBeNull();
      await require('../../src/services/uploadReviewService').moderatePhotos(eventId, [id], 'approve');
      expect(JSON.parse((await db('photos').where({ id }).first()).edit_params)).toMatchObject({ develop: true });
    } finally {
      isRaw.mockRestore();
      await require('../../src/utils/appSettings').upsertAppSetting(photoEdits().AUTO_DEVELOP_SETTING, 'false', 'boolean');
      await db('photos').where({ id }).delete();
    }
  });
});

describe('develop all RAWs of a large gallery', () => {
  it('saves them in bounded transactions, not one for all', async () => {
    const rawDevelop = require('../../src/services/rawDevelop');
    const isRaw = jest.spyOn(rawDevelop, 'isRawSource').mockResolvedValue(true);
    const rows = Array.from({ length: 450 }, (_, i) => ({
      event_id: eventId, filename: `bulk${i}.cr3`, path: 'edit-card/card.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/x-canon-cr3', width: 600, height: 400, size_bytes: 1, processing_status: 'complete', uploaded_at: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 100) await db('photos').insert(rows.slice(i, i + 100));
    const photos = await db('photos').where('filename', 'like', 'bulk%.cr3');
    // A transaction is the one write that updates edit_rev for many rows: count those.
    let begun = 0;
    const count = (query) => { if (/^begin/i.test(query.sql)) begun++; };
    db.on('query', count);
    try {
      expect(await photoEdits().queueDefaultDevelop(photos)).toHaveLength(450);
      expect(begun).toBe(3);
    } finally {
      db.removeListener('query', count);
      isRaw.mockRestore();
      await db('photos').where('filename', 'like', 'bulk%.cr3').delete();
    }
  });
});

describe('the default RAW develop and a manual edit saved meanwhile', () => {
  it('never replaces the edit: the default is written only over the unedited row it was queued from', async () => {
    const rawDevelop = require('../../src/services/rawDevelop');
    const isRaw = jest.spyOn(rawDevelop, 'isRawSource').mockResolvedValue(true);
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'race.cr3', path: 'edit-card/card.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/x-canon-cr3', width: 600, height: 400, size_bytes: 1, processing_status: 'complete', uploaded_at: new Date().toISOString(),
    }).returning('id'));
    try {
      // The batch (or an upload's auto develop) read the photo unedited...
      const snapshot = await db('photos').where({ id }).first();
      // ...an admin saved an edit meanwhile...
      await photoEdits().saveEdits([{ photo: await db('photos').where({ id }).first(), params: validated({ exposure: 1, develop: true }) }]);
      // ...and the default lands afterwards.
      expect(await photoEdits().queueDefaultDevelop([snapshot])).toEqual([]);
      const after = await db('photos').where({ id }).first();
      expect(JSON.parse(after.edit_params)).toMatchObject({ exposure: 1 });
      expect(after.edit_rev).toBe(1);
    } finally {
      isRaw.mockRestore();
      await db('photos').where({ id }).delete();
    }
  });
});

describe('two replicas rendering the same revision', () => {
  it('the later one adopts the render the first published, and that file survives', async () => {
    fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath('events/active/edit-card/race.jpg'));
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'race.jpg', path: 'edit-card/race.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const fresh = () => db('photos').where({ id }).first();
    await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ exposure: 0.4 }) }]);
    // Replica B: its own module instances (its own flights), the same database and storage.
    let replica; let replicaStorage; let replicaDb; let replicaSharp;
    jest.isolateModules(() => {
      replica = require('../../src/services/photoEdits');
      replicaStorage = require('../../src/services/storage').getStorage();
      replicaDb = require('../../src/database/db').db;
      replicaSharp = require('../../src/services/isolatedSharp');
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let rendered;
    const renderedByB = new Promise((resolve) => { rendered = resolve; });
    const put = replicaStorage.put.bind(replicaStorage);
    jest.spyOn(replicaStorage, 'put').mockImplementation(async (key, ...rest) => {
      if (String(key).startsWith('edits/')) { rendered(key); await gate; }
      return put(key, ...rest);
    });
    // B read the row (no render yet) and rendered; it is held before publishing.
    try {
      const b = replica.ensureEditedSource(await fresh());
      const keyB = await Promise.race([renderedByB, b.then(() => { throw new Error('B finished without publishing'); })]);
      // A renders and publishes meanwhile; a download now holds A's key.
      const keyA = await photoEdits().ensureEditedSource(await fresh());
      expect(keyA).not.toBe(keyB);
      release();
      expect(await b).toBe(keyA);
      expect((await fresh()).edit_render_path).toBe(keyA);
      expect(fs.existsSync(storagePath(keyA))).toBe(true);
      expect(fs.existsSync(storagePath(keyB))).toBe(false);
    } finally {
      release();
      await replicaSharp.shutdown();
      await replicaDb.destroy();
      await db('photos').where({ id }).delete();
    }
  });
});

describe('a pass over many edited photos', () => {
  it('reads the rendition owners once, not once a photo', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath(`events/active/edit-card/batch${i}.jpg`));
      ids.push(unwrap(await db('photos').insert({
        event_id: eventId, filename: `batch${i}.jpg`, path: `edit-card/batch${i}.jpg`, type: 'individual', media_type: 'image',
        mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
        uploaded_at: new Date().toISOString(),
      }).returning('id')));
    }
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const rows = [];
    for (const id of ids) {
      await ensureThumbnail(await db('photos').where({ id }).first(), { force: true });
      rows.push({ photo: await db('photos').where({ id }).first(), params: validated({ exposure: 0.5 }) });
    }
    await photoEdits().saveEdits(rows);
    // The owner scan reads every row's rendition keys; it is the cost that
    // must not grow with the batch.
    let scans = 0;
    const count = (query) => { if (/select .*thumbnail_path.*preview_path.*hero_path.* from .photos. where .id. > \?/.test(query.sql)) scans++; };
    db.on('query', count);
    try {
      expect(await photoEdits().runPass({ active: () => true, sleep: async () => {} })).toMatchObject({ applied: 3, failed: 0 });
    } finally {
      db.removeListener('query', count);
    }
    for (const id of ids) expect((await db('photos').where({ id }).first()).thumbnail_path).toContain(`edit_p${id}_r1_`);
    // One paged scan: a page with the rows and the empty page that ends it.
    expect(scans).toBe(2);
    await db('photos').whereIn('id', ids).delete();
  });
});

describe('a render that fails', () => {
  it('is recorded on the row, so every replica reports it and a retry anywhere asks again', async () => {
    fs.writeFileSync(storagePath('events/active/edit-card/broken.jpg'), 'not an image');
    const brokenId = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'broken.jpg', path: 'edit-card/broken.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: 12, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const broken = () => db('photos').where({ id: brokenId }).first();
    try {
      await photoEdits().saveEdits([{ photo: await broken(), params: validated({ exposure: 1 }) }]);
      expect(await photoEdits().runPass({ active: () => true, sleep: async () => {} })).toMatchObject({ failed: 1 });
      expect(await broken()).toMatchObject({ edit_rev: 1, edit_applied_rev: 0, edit_failed_rev: 1, edit_error: 'render' });
      expect(photoEdits().hasFailed(await broken())).toBe(true);
      // Another replica (no memory of this pass) sees it and can retry it.
      let other;
      jest.isolateModules(() => { other = require('../../src/services/photoEdits'); });
      expect(other.hasFailed(await broken())).toBe(true);
      expect(await photoEdits().retry(eventId, [brokenId])).toBe(1);
      expect(await broken()).toMatchObject({ edit_failed_rev: null, edit_error: null });
      // A new save is a new revision: not failed until a pass has tried it.
      await photoEdits().runPass({ active: () => true, sleep: async () => {} });
      await photoEdits().saveEdits([{ photo: await broken(), params: validated({ exposure: 0.5 }) }]);
      expect(photoEdits().hasFailed(await broken())).toBe(false);
    } finally {
      await db('photos').where({ id: brokenId }).delete();
    }
  });
});

describe('deleting photos leaves no edit files behind', () => {
  // A RAW by name with a develop preview file, and an edited JPEG with its render.
  const plant = async (slug) => {
    const { adminId } = { adminId: (await db('admin_users').first('id')).id };
    const event = unwrap(await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01', host_email: 'h@example.com',
      admin_email: 'a@example.com', password_hash: 'x', share_token: `tok-${slug}`, share_link: `/gallery/${slug}/tok`,
      created_by: adminId, expires_at: new Date(Date.now() + 864e5).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
    const dir = storagePath(`events/active/${slug}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw.dng'), 'raw');
    fs.writeFileSync(path.join(dir, 'pic.jpg'), originalBytes);
    const insert = async (filename, over = {}) => unwrap(await db('photos').insert({
      event_id: event, filename, path: `${slug}/${filename}`, type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: 3, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 600, height: 400, ...over,
    }).returning('id'));
    const rawId = await insert('raw.dng', { mime_type: 'image/x-adobe-dng' });
    const jpegId = await insert('pic.jpg');
    const raw = await db('photos').where({ id: rawId }).first();
    const previewKey = require('../../src/services/rawDevelop').previewKey(raw);
    fs.mkdirSync(path.dirname(storagePath(previewKey)), { recursive: true });
    fs.writeFileSync(storagePath(previewKey), 'preview');
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id: jpegId }).first(), params: validated({ exposure: 0.4 }) }]);
    const render = await photoEdits().ensureEditedSource(await db('photos').where({ id: jpegId }).first());
    // The applied revision's render too: a newer edit pending, its own render drawn.
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id: jpegId }).first(), params: validated({ exposure: 0.8 }) }]);
    const pending = await photoEdits().ensureEditedSource(await db('photos').where({ id: jpegId }).first());
    expect((await db('photos').where({ id: jpegId }).first()).edit_applied_render_path).toBe(render);
    return { event, rawId, jpegId, files: [previewKey, render, pending] };
  };

  it('a gallery delete removes renders and RAW develop previews', async () => {
    const { event, files } = await plant('edit-delete-gallery');
    for (const key of files) expect(fs.existsSync(storagePath(key))).toBe(true);
    await require('../../src/routes/adminEvents/helpers').deleteEventCascade(event, { id: (await db('admin_users').first('id')).id });
    for (const key of files) expect(fs.existsSync(storagePath(key))).toBe(false);
  });

  it('a photo deleted for good removes them too', async () => {
    const { event, rawId, jpegId, files } = await plant('edit-delete-photo');
    const trash = require('../../src/services/photoTrash');
    const gallery = await db('events').where({ id: event }).first();
    for (const id of [rawId, jpegId]) await trash.deletePhotoForGood(gallery, await db('photos').where({ id }).first());
    for (const key of files) expect(fs.existsSync(storagePath(key))).toBe(false);
  });
});

describe('a reference photo rewritten on its share', () => {
  it('keeps its edit: the thumbnail is cut from the edit again and the revision moves on', async () => {
    const adminId = (await db('admin_users').first('id')).id;
    await require('../integration/helpers/crmDb').assignAdminRole(db, adminId, 'super_admin');
    const actor = { type: 'admin', id: adminId };
    const event = unwrap(await db('events').insert({
      slug: 'edit-reference', event_type: 'wedding', event_name: 'Reference', event_date: '2026-08-01', host_email: 'h@example.com',
      admin_email: 'a@example.com', password_hash: 'x', share_token: 'tok-ref', share_link: '/gallery/edit-reference/tok',
      created_by: adminId, expires_at: new Date(Date.now() + 864e5).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
      source_mode: 'reference', external_path: 'shoot', created_at: new Date().toISOString(),
    }).returning('id'));
    const file = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'shoot', 'red.jpg');
    const write = async (colour, size) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await sharp({ create: { width: size, height: 300, channels: 3, background: colour } }).jpeg().toBuffer());
      const old = new Date(Date.now() - 120000);
      fs.utimesSync(file, old, old);
    };
    const { importExternalFolder } = require('../../src/services/externalImportService');
    await write({ r: 220, g: 30, b: 30 }, 400);
    await importExternalFolder({ eventId: event, externalPath: 'shoot', actor });
    const photo = await db('photos').where({ event_id: event }).first();
    await photoEdits().saveEdits([{ photo, params: validated({ bw: true }) }]);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    const before = await db('photos').where({ id: photo.id }).first();

    await write({ r: 30, g: 30, b: 220 }, 420);
    await importExternalFolder({ eventId: event, externalPath: 'shoot', actor });
    const after = await db('photos').where({ id: photo.id }).first();
    expect(after.size_bytes).not.toBe(before.size_bytes);
    expect(after.edit_rev).toBe(before.edit_rev + 1);
    expect(after.thumbnail_path).toBeTruthy();
    const { channels } = await sharp(storagePath(after.thumbnail_path)).stats();
    // Black and white still: the new blue file, edited.
    expect(Math.abs(channels[0].mean - channels[2].mean)).toBeLessThan(3);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    expect(await db('photos').where({ id: photo.id }).first()).toMatchObject({ edit_applied_rev: after.edit_rev });
  });
});

describe('edited tiers after a reset', () => {
  const tierFor = async (photoId) => require('../../src/services/imageProcessor').ensurePreviewImageAtWidth(await db('photos').where({ id: photoId }).first(), 640);
  const plantEdited = async (name) => {
    fs.writeFileSync(storagePath(`events/active/edit-card/${name}`), originalBytes);
    const id = unwrap(await db('photos').insert({
      event_id: (await row()).event_id, filename: name, path: `edit-card/${name}`, type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id }).first(), params: validated({ saturation: -50 }) }]);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    const tier = await tierFor(id);
    expect(tier).toMatch(/_e1_/);
    expect(fs.existsSync(storagePath(tier))).toBe(true);
    return { id, tier };
  };

  it('the reset removes the tiers the edit had', async () => {
    const { id, tier } = await plantEdited('tiers-reset.jpg');
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id }).first(), params: null }]);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    expect(fs.existsSync(storagePath(tier))).toBe(false);
  });

  it('a geometry edit that moves a manual focal point leaves no tiers cut at the old point', async () => {
    const { id } = await plantEdited('tiers-focal.jpg');
    await db('photos').where({ id }).update({ focal_x: 0.2, focal_y: 0.4, focal_source: 'manual' });
    const imageProcessor = require('../../src/services/imageProcessor');
    const cut = await imageProcessor.ensureThumbnailAtWidth(await db('photos').where({ id }).first(), 600);
    expect(cut).toMatch(/_e1_f/);
    expect(fs.existsSync(storagePath(cut))).toBe(true);
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id }).first(), params: validated({ saturation: -50, rotate: 90 }) }]);
    // The point turned with the photo: the old tier's key names a point the row no longer has.
    expect(await db('photos').where({ id }).first()).toMatchObject({ focal_source: 'manual' });
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    const gallery = await db('events').where({ id: (await row()).event_id }).first();
    await require('../../src/services/photoTrash').deletePhotoForGood(gallery, await db('photos').where({ id }).first());
    expect(fs.existsSync(storagePath(cut))).toBe(false);
  });

  it('keeps the focal point the previews are cut around until the turn that moves it is applied', async () => {
    const { id } = await plantEdited('tiers-focal-staged.jpg');
    await db('photos').where({ id }).update({ focal_x: 0.2, focal_y: 0.4, focal_source: 'manual' });
    const imageProcessor = require('../../src/services/imageProcessor');
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id }).first(), params: validated({ saturation: -50, rotate: 90 }) }]);
    // Saved, not applied: the previews are still the unturned ones, cut around the point as it was.
    expect(await db('photos').where({ id }).first()).toMatchObject({ focal_x: 0.2, focal_y: 0.4, focal_source: 'manual' });
    const pendingTier = await imageProcessor.ensureThumbnailAtWidth(await db('photos').where({ id }).first(), 600);
    expect(pendingTier).toMatch(/_e1_f200-400_/);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    // Applied: the point turned with the picture, and the tiers of the old one are gone.
    const after = await db('photos').where({ id }).first();
    expect(after).toMatchObject({ edit_applied_rev: 2, focal_x: 0.6, focal_y: 0.2, focal_source: 'manual' });
    expect(fs.existsSync(storagePath(pendingTier))).toBe(false);
  });

  it('a delete after a reset still pending removes them too', async () => {
    const { id, tier } = await plantEdited('tiers-delete.jpg');
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id }).first(), params: null }]);
    const gallery = await db('events').where({ id: (await row()).event_id }).first();
    await require('../../src/services/photoTrash').deletePhotoForGood(gallery, await db('photos').where({ id }).first());
    expect(fs.existsSync(storagePath(tier))).toBe(false);
  });
});

describe('face covers of an edited photo', () => {
  it('are boxes in the edited image: turned with it, and a face cropped away is no cover', async () => {
    const eventId = (await row()).event_id;
    const insertPhoto = async (name, edit) => unwrap(await db('photos').insert({
      event_id: eventId, filename: name, path: `edit-card/${name}`, type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      width: 600, height: 400, size_bytes: 1, processing_status: 'complete', uploaded_at: new Date().toISOString(),
      edit_params: edit ? math.canonicalJson(validated(edit)) : null, edit_rev: edit ? 1 : 0, edit_applied_rev: edit ? 1 : 0,
      edit_applied_params: edit ? math.canonicalJson(validated(edit)) : null,
    }).returning('id'));
    const turned = await insertPhoto('face-turned.jpg', { rotate: 90 });
    const cropped = await insertPhoto('face-cropped.jpg', { crop: { x: 0.5, y: 0, w: 0.5, h: 1 } });
    const people = [];
    for (const label of ['Turned', 'Cropped']) {
      people.push(unwrap(await db('event_people').insert({ event_id: eventId, label, face_count_total: 1 }).returning('id')));
    }
    const face = (photoId, personId, x, score) => db('photo_faces').insert({
      photo_id: photoId, event_id: eventId, person_id: personId, bbox_x: x, bbox_y: 100, bbox_w: 60, bbox_h: 80, det_score: score,
    });
    await face(turned, people[0], 100, 0.9);
    // The best face of the second person is in the half the crop removed;
    // the next one survives the crop.
    await face(cropped, people[1], 50, 0.99);
    await face(cropped, people[1], 400, 0.5);
    const list = await require('../../src/services/facePeopleService').listPeople(eventId, { forAdmin: true, minClusterSize: 1 });
    const byLabel = Object.fromEntries(list.map((p) => [p.label, p.cover]));
    // Turned 90 degrees clockwise: x' = 400 - (y + h), y' = x, in a 400 x 600 image.
    expect(byLabel.Turned).toMatchObject({ bbox: [220, 100, 80, 60], photo_width: 400, photo_height: 600 });
    expect(byLabel.Cropped).toMatchObject({ bbox: [100, 100, 60, 80], photo_width: 300, photo_height: 400 });
  });
});

describe('face covers of an edited photo delivered smaller', () => {
  it('are boxes in the delivered image, the size the listing reports', async () => {
    const eventId = (await row()).event_id;
    // Turned, and delivered at half the edited size (PHOTO_EDIT_MAX_PIXELS, or a half-size RAW develop).
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'face-capped.jpg', path: 'edit-card/face-capped.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      width: 600, height: 400, size_bytes: 1, processing_status: 'complete', uploaded_at: new Date().toISOString(),
      edit_params: math.canonicalJson(validated({ rotate: 90 })), edit_rev: 1, edit_applied_rev: 1, edit_width: 200, edit_height: 300,
      edit_applied_params: math.canonicalJson(validated({ rotate: 90 })), edit_applied_width: 200, edit_applied_height: 300,
    }).returning('id'));
    const person = unwrap(await db('event_people').insert({ event_id: eventId, label: 'Capped', face_count_total: 1 }).returning('id'));
    await db('photo_faces').insert({ photo_id: id, event_id: eventId, person_id: person, bbox_x: 100, bbox_y: 100, bbox_w: 60, bbox_h: 80, det_score: 0.9 });
    const list = await require('../../src/services/facePeopleService').listPeople(eventId, { forAdmin: true, minClusterSize: 1 });
    // In the 400 x 600 edit the box is [220, 100, 80, 60]; delivered at 200 x 300 it is half that.
    // With the applied revision, which names the preview the box belongs to.
    expect(list.find((p) => p.label === 'Capped').cover).toMatchObject({ bbox: [110, 50, 40, 30], photo_width: 200, photo_height: 300, edit_applied_rev: 1 });
  });
});

describe('face covers while an edit is being applied', () => {
  it('follow the applied revision: unchanged while pending, turned once applied, kept after a failed render', async () => {
    const eventId = (await row()).event_id;
    fs.copyFileSync(storagePath('events/active/edit-card/card.jpg'), storagePath('events/active/edit-card/face-pending.jpg'));
    const id = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'face-pending.jpg', path: 'edit-card/face-pending.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', width: 600, height: 400, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const person = unwrap(await db('event_people').insert({ event_id: eventId, label: 'Pending', face_count_total: 1 }).returning('id'));
    await db('photo_faces').insert({ photo_id: id, event_id: eventId, person_id: person, bbox_x: 100, bbox_y: 100, bbox_w: 60, bbox_h: 80, det_score: 0.9 });
    const cover = async () => (await require('../../src/services/facePeopleService').listPeople(eventId, { forAdmin: true, minClusterSize: 1 }))
      .find((p) => p.label === 'Pending').cover;
    const fresh = () => db('photos').where({ id }).first();
    const unturned = { bbox: [100, 100, 60, 80], photo_width: 600, photo_height: 400 };
    const turned = { bbox: [220, 100, 80, 60], photo_width: 400, photo_height: 600 };
    try {
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ rotate: 90 }) }]);
      // Guests still get the unturned previews: the boxes are theirs.
      expect(await cover()).toMatchObject({ ...unturned, edit_applied_rev: 0 });
      await photoEdits().runPass({ active: () => true, sleep: async () => {} });
      expect(await cover()).toMatchObject({ ...turned, edit_applied_rev: 1 });
      // A crop whose render fails: the turned previews stay, and so do their boxes.
      await photoEdits().saveEdits([{ photo: await fresh(), params: validated({ rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 } }) }]);
      fs.renameSync(storagePath('events/active/edit-card/face-pending.jpg'), storagePath('events/active/edit-card/face-pending.gone'));
      try {
        expect(await photoEdits().runPass({ active: () => true, sleep: async () => {} })).toMatchObject({ failed: 1 });
      } finally {
        fs.renameSync(storagePath('events/active/edit-card/face-pending.gone'), storagePath('events/active/edit-card/face-pending.jpg'));
      }
      expect(await cover()).toMatchObject({ ...turned, edit_applied_rev: 1 });
    } finally {
      await db('photo_faces').where({ photo_id: id }).delete();
      await db('photos').where({ id }).delete();
    }
  });
});

describe('focal point after a geometry change', () => {
  it('carries a manual point through a rotation and clears a detected one', () => {
    const photo = { width: 600, height: 400, focal_x: 0.25, focal_y: 0.5, focal_source: 'manual' };
    // 90 clockwise: the left middle moves to the top middle.
    expect(photoEdits().focalAfterEdit(photo, null, validated({ rotate: 90 }))).toEqual({ focal_x: 0.5, focal_y: 0.25, focal_source: 'manual' });
    expect(photoEdits().focalAfterEdit({ ...photo, focal_source: 'auto' }, null, validated({ rotate: 90 })))
      .toEqual({ focal_x: null, focal_y: null, focal_source: null });
    // Tone only: nothing moves.
    expect(photoEdits().focalAfterEdit(photo, null, validated({ exposure: 1 }))).toBeUndefined();
  });
});
