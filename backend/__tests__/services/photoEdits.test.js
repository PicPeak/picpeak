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

  it('carries the source EXIF with the orientation upright', async () => {
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

describe('embedded images of the source', () => {
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
    // The text metadata stays.
    expect(buffer.indexOf('Leakcam')).toBeGreaterThan(-1);
    expect(buffer.indexOf('CreatorTool="Studio"')).toBeGreaterThan(-1);
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
    expect(await photoEdits().status(eventId)).toMatchObject({ pending: 0, failed: 0 });
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
    expect(fs.readdirSync(editsDir).filter((name) => name.includes(`_r${stale.edit_rev}_`) && name.startsWith('edit_'))).toHaveLength(0);
    expect(fs.readdirSync(editsDir).length).toBe(filesBefore);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
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
    return { event, rawId, jpegId, files: [previewKey, render] };
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

  it('a delete after a reset still pending removes them too', async () => {
    const { id, tier } = await plantEdited('tiers-delete.jpg');
    await photoEdits().saveEdits([{ photo: await db('photos').where({ id }).first(), params: null }]);
    const gallery = await db('events').where({ id: (await row()).event_id }).first();
    await require('../../src/services/photoTrash').deletePhotoForGood(gallery, await db('photos').where({ id }).first());
    expect(fs.existsSync(storagePath(tier))).toBe(false);
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
