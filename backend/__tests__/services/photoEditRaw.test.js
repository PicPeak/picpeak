/**
 * Camera RAW development for the photo editor (issue 2619), through LibRaw's
 * dcraw_emu and raw-identify, on the synthetic DNG in fixtures/raw (its scene
 * is known: makeSyntheticDng.js).
 *
 * Needs dcraw_emu (Alpine libraw-tools, Debian/Ubuntu libraw-bin). Without it
 * the suite is skipped with a note, except where PICPEAK_REQUIRE_DCRAW=true
 * (the CI job installs it), where a missing binary fails the suite.
 *
 * Pins:
 *  - raw-identify gives the as-shot multipliers; the highlight rebuild's
 *    darkening is measured and given back (middle grey lands on 0.18)
 *  - the develop preview (half size, 16-bit linear) round-trips through its
 *    cache file and is cached per original
 *  - golden: the saved render of a RAW photo matches the CPU reference built
 *    from LibRaw's full develop and the formulas, within JPEG noise
 *  - the capture date is carried onto the JPEG (exiftool), the original
 *    stays untouched, a RAW without an edit keeps its embedded preview path
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-raw-')), 'db.sqlite');
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-raw-storage-'));

const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const math = require('../../src/utils/photoEditMath');

const FIXTURE = path.join(__dirname, '../fixtures/raw/synthetic.dng');
const runs = (bin) => !spawnSync(bin, [], { stdio: 'ignore' }).error;
const HAVE_DCRAW = runs(process.env.DCRAW_EMU_PATH || 'dcraw_emu') && runs(process.env.RAW_IDENTIFY_PATH || 'raw-identify');
const HAVE_EXIFTOOL = runs('exiftool');
const REQUIRED = process.env.PICPEAK_REQUIRE_DCRAW === 'true';

jest.setTimeout(300000);

if (!HAVE_DCRAW && REQUIRED) {
  test('dcraw_emu is installed (PICPEAK_REQUIRE_DCRAW)', () => {
    throw new Error('dcraw_emu / raw-identify (LibRaw) are required here but not on PATH: install libraw-bin');
  });
}

const describeRaw = HAVE_DCRAW ? describe : describe.skip;
if (!HAVE_DCRAW && !REQUIRED) {
  // eslint-disable-next-line no-console
  console.warn('photoEditRaw.test.js skipped: dcraw_emu (LibRaw) is not installed; set DCRAW_EMU_PATH or install libraw-tools/libraw-bin');
}

describeRaw('RAW development (LibRaw dcraw_emu)', () => {
  let db; let cleanup; let photoId; let originalBytes;
  const storagePath = (key) => path.join(process.env.STORAGE_PATH, key);
  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const row = () => db('photos').where({ id: photoId }).first();
  const rawDevelop = () => require('../../src/services/rawDevelop');
  const photoEdits = () => require('../../src/services/photoEdits');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    const eventId = unwrap(await db('events').insert({
      slug: 'raw-card', event_type: 'wedding', event_name: 'RAW card', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 'tok-raw-card', share_link: '/gallery/raw-card/tok-raw-card',
      created_by: adminId, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id'));
    const dir = storagePath('events/active/raw-card');
    fs.mkdirSync(dir, { recursive: true });
    originalBytes = fs.readFileSync(FIXTURE);
    fs.writeFileSync(path.join(dir, 'card.dng'), originalBytes);
    photoId = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'card.dng', original_filename: 'CARD.DNG', path: 'raw-card/card.dng',
      type: 'individual', media_type: 'image', mime_type: 'image/x-adobe-dng', width: 384, height: 256,
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(),
    }).returning('id'));
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
  });

  it('reads the as-shot white balance and gives back the highlight rebuild\'s darkening', async () => {
    const info = await rawDevelop().identify(FIXTURE);
    expect(info).toMatchObject({ width: 384, height: 256 });
    expect(info.multipliers.slice(0, 3).map((v) => Math.round(v * 100) / 100)).toEqual([2, 1, 1.43]);
    expect(info.exposureBias).toBeCloseTo(1, 3);
    const image = await rawDevelop().developLinear(FIXTURE, { size: info });
    // A mid-grey patch of the scene (0.18), as-shot balanced: neutral, and
    // 0.18 once the bias is given back.
    const i = (200 * image.width + 20) * 3;
    const grey = [0, 1, 2].map((c) => (image.data[i + c] / 65535) * 2 ** info.exposureBias);
    for (const v of grey) expect(v).toBeCloseTo(0.18, 1);
    expect(Math.abs(grey[0] - grey[2])).toBeLessThan(0.01);
  });

  it('develops a half-size preview, encodes it and caches it per original', async () => {
    const photo = await row();
    const first = await rawDevelop().developPreview(photo, photoEdits().withOriginal);
    const decoded = rawDevelop().decodePreview(first);
    expect(decoded.header).toMatchObject({ width: 192, height: 128, bits: 16, linear: true, exposureBias: expect.any(Number) });
    expect(fs.existsSync(storagePath(rawDevelop().previewKey(photo)))).toBe(true);
    // Cached: the same bytes without a develop.
    const second = await rawDevelop().developPreview(photo, async () => { throw new Error('developed again'); });
    expect(second.equals(first)).toBe(true);
    expect(rawDevelop().previewKey({ ...photo, size_bytes: 1 })).not.toBe(rawDevelop().previewKey(photo));
  });

  it('renders a developed RAW to JPEG that matches the reference (golden)', async () => {
    const params = math.validateEditParams({ develop: true, exposure: 0.3, highlights: -30, vibrance: 20 }).params;
    await photoEdits().saveEdits([{ photo: await row(), params }]);
    const runner = require('../../src/services/mediaProcessService');
    const run = jest.spyOn(runner, 'run');
    try {
      expect(await photoEdits().runPass({ active: () => true, sleep: async () => {} })).toMatchObject({ applied: 1, failed: 0 });
      // The container's tags are copied from an allowlist only: no group of
      // tags, so no thumbnail, maker note, MPF or XMP image comes along.
      const copy = run.mock.calls.find(([command, args]) => command === 'exiftool' && args.includes('-TagsFromFile'));
      if (HAVE_EXIFTOOL) {
        expect(copy[1]).toEqual(expect.arrayContaining(['-EXIF:DateTimeOriginal', '-EXIF:Copyright', '-XMP-dc:Creator']));
        expect(copy[1].filter((arg) => /(^-+|:)all$|MakerNote|IFD1|Thumbnail|Preview/i.test(arg))).toEqual([]);
      }
    } finally {
      run.mockRestore();
    }
    const current = await row();
    const jpeg = fs.readFileSync(storagePath(current.edit_render_path));
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([384, 256]);

    const develop = await rawDevelop().developLinear(FIXTURE, { size: await rawDevelop().identify(FIXTURE) });
    const { exposureBias } = await rawDevelop().identify(FIXTURE);
    const prep = math.prepare(params, { linear: true, exposureBias });
    // Reference without the detail planes: they only drive highlights here,
    // whose mask the local detail moves a little; the tolerance covers that.
    let sum = 0;
    const diffs = [];
    for (let p = 0; p < info.width * info.height; p++) {
      const ref = math.referencePixel([develop.data[p * 3] / 65535, develop.data[p * 3 + 1] / 65535, develop.data[p * 3 + 2] / 65535], params, { linear: true, exposureBias, prep });
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(data[p * 3 + c] - ref[c] * 255);
        sum += d;
        diffs.push(d);
      }
    }
    diffs.sort((a, b) => a - b);
    const mean = sum / diffs.length;
    expect(mean).toBeLessThan(1.5);
    expect(diffs[Math.floor(diffs.length * 0.999)]).toBeLessThan(16);
    expect(fs.readFileSync(storagePath('events/active/raw-card/card.dng')).equals(originalBytes)).toBe(true);
    // Guests download it as a JPEG named like the photo.
    const delivered = await photoEdits().deliveredPhoto(current);
    expect(delivered).toMatchObject({ mime_type: 'image/jpeg', filename: 'card.jpg', original_filename: 'CARD.jpg' });
  });

  (HAVE_EXIFTOOL ? it : it.skip)('carries the capture date onto the developed JPEG', async () => {
    const jpeg = fs.readFileSync(storagePath((await row()).edit_render_path));
    const exif = require('exifr');
    const tags = await exif.parse(jpeg, ['DateTimeOriginal', 'Make', 'Orientation']);
    expect(tags.Make).toBe('PicPeak');
    expect(await exif.thumbnail(jpeg)).toBeUndefined();
    expect(tags.DateTimeOriginal).toBeTruthy();
    expect(tags.Orientation === undefined || tags.Orientation === 1 || tags.Orientation === 'Horizontal (normal)').toBe(true);
  });

  it('the batch develop queues RAW photos without an edit, and only those', async () => {
    await photoEdits().saveEdits([{ photo: await row(), params: null }]);
    await photoEdits().runPass({ active: () => true, sleep: async () => {} });
    expect(await photoEdits().queueDefaultDevelop([await row(), { id: 99999, filename: 'x.jpg', media_type: 'image' }])).toEqual([photoId]);
    expect(JSON.parse((await row()).edit_params)).toMatchObject({ develop: true, exposure: 0 });
    expect(await photoEdits().queueDefaultDevelop([await row()])).toEqual([]);
  });
});

// No LibRaw needed: what a real camera file asks of the process budget. The
// synthetic DNG is tiny; a 24 MP sensor writes 144 MB of 16-bit RGB.
describe('the output budget of a develop', () => {
  const rawDevelop = () => require('../../src/services/rawDevelop');
  const MB = 1024 * 1024;

  it('fits the 16-bit image of a 24 MP sensor, full size and half', () => {
    const size = { width: 6000, height: 4000 };
    const full = rawDevelop().outputBudget(size, { half: false });
    expect(full).toBeGreaterThanOrEqual(6000 * 4000 * 6);
    expect(full).toBeLessThan(6000 * 4000 * 6 * 1.1);
    const half = rawDevelop().outputBudget(size, { half: true });
    expect(half).toBeGreaterThanOrEqual(3000 * 2000 * 6);
    expect(half).toBeLessThan(full / 3);
  });

  it('refuses a sensor beyond the pixel cap, or of no known size, before anything runs', () => {
    expect(() => rawDevelop().outputBudget({ width: 20000, height: 20000 }, { half: false })).toThrow(/too large/);
    expect(() => rawDevelop().outputBudget({ width: null, height: null }, { half: false })).toThrow(/size/);
    expect(() => rawDevelop().outputBudget(null, { half: true })).toThrow(/size/);
    expect(MB).toBeGreaterThan(0);
  });

  it('reads a develop into one buffer of its size: the header first, then the body straight in, whatever the header length', async () => {
    const os = require('os');
    for (const header of ['P6\n3 2\n65535\n', 'P6 3 2 65535\n', 'P6\n3  2\n65535\n']) {
      const body = Buffer.alloc(3 * 2 * 6);
      for (let i = 0; i < body.length / 2; i++) body.writeUInt16BE(i * 1000, i * 2);
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-')), 'x.ppm');
      fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), body, Buffer.from('trailing')]));
      const readFile = jest.spyOn(fs.promises, 'readFile');
      try {
        const image = await rawDevelop().readPpm(file);
        expect(readFile).not.toHaveBeenCalled();
        expect(image).toMatchObject({ width: 3, height: 2 });
        expect(Array.from(image.data)).toEqual(Array.from({ length: 18 }, (_, i) => i * 1000));
        // A view of the buffer it was read into, aligned, no copy.
        expect(image.data.byteOffset % 2).toBe(0);
        expect(image.data.buffer.byteLength).toBe(36);
      } finally {
        readFile.mockRestore();
      }
    }
  });

  it('hands that budget to the process as its file budget', async () => {
    const media = require('../../src/services/mediaProcessService');
    const run = jest.spyOn(media, 'run').mockRejectedValue(Object.assign(new Error('stop'), { code: 'STOP' }));
    try {
      await expect(rawDevelop().developLinear('/nonexistent.cr3', { half: true, size: { width: 6000, height: 4000 } })).rejects.toThrow('stop');
      const options = run.mock.calls[0][2];
      expect(options.stdoutPath).toBeTruthy();
      expect(options.fileBytes).toBe(rawDevelop().outputBudget({ width: 6000, height: 4000 }, { half: true }));
    } finally {
      run.mockRestore();
    }
  });
});
