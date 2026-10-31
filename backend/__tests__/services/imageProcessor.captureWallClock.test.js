/**
 * The camera's own capture clock (issue 2305).
 *
 * extractCapture reads the EXIF date raw: captured_at keeps the instant
 * exifr made of it in the server's zone (unchanged), captured_at_wall the
 * time as the camera wrote it. The zone cases run in a Europe/Berlin child
 * process, where the spring-forward gap is real (2026-03-29 02:30 does not
 * exist): TZ does not re-bind inside a running jest worker, and CI is UTC.
 */
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const exifr = require('exifr');

// imageProcessor reads its settings from app_settings at require time; same
// stub as imageProcessor.stripMetadata.test.js.
jest.mock('../../src/database/db', () => {
  const api = () => ({ where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] });
  return { db: api };
});

const { extractCapture, extractCaptureDate, captureWallColumn } = require('../../src/services/imageProcessor');

// extractCapture in a child process running in Europe/Berlin, next to what
// exifr's revived Date (the value extractCaptureDate returned before this
// change) gives there. The child stubs the database module the same way.
const inBerlin = (file) => JSON.parse(execFileSync(process.execPath, ['-e', `
  const Module = require('module');
  const dbPath = require.resolve(${JSON.stringify(path.resolve(__dirname, '../../src/database/db'))});
  const stub = new Module(dbPath); stub.filename = dbPath; stub.loaded = true;
  stub.exports = { db: () => ({ where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] }) };
  require.cache[dbPath] = stub;
  const exifr = require('exifr');
  const { extractCapture } = require(${JSON.stringify(path.resolve(__dirname, '../../src/services/imageProcessor'))});
  (async () => {
    const file = ${JSON.stringify(file)};
    const c = await extractCapture(file);
    const e = await exifr.parse(file, { pick: ['DateTimeOriginal'] });
    process.stdout.write(JSON.stringify({
      offset: new Date(2026, 6, 1).getTimezoneOffset(),
      wall: c.wall, capturedAt: c.capturedAt.toISOString(), hours: c.capturedAt.getHours(),
      revived: e.DateTimeOriginal.toISOString(),
    }));
    process.exit(0);
  })();
`], { env: { ...process.env, TZ: 'Europe/Berlin' }, encoding: 'utf8' }));

describe('extractCapture (issue 2305)', () => {
  let tmpDir;
  const jpeg = async (name, exif) => {
    const file = path.join(tmpDir, name);
    let img = sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } } });
    if (exif) img = img.withExif(exif);
    await img.jpeg().toFile(file);
    return file;
  };
  // What extractCaptureDate returned before this change: exifr's revived Date.
  const revived = async (file) => {
    const e = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'ModifyDate'] });
    return e && (e.DateTimeOriginal || e.CreateDate || e.DateTimeDigitized || e.ModifyDate);
  };

  beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-wallclock-')); });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('returns the camera time as written, and the same instant as before', async () => {
    const file = await jpeg('plain.jpg', { IFD2: { DateTimeOriginal: '2025:06:01 09:45:03' } });
    const capture = await extractCapture(file);
    expect(capture.wall).toBe('2025-06-01T09:45:03');
    expect(capture.capturedAt.getTime()).toBe((await revived(file)).getTime());
    expect((await extractCaptureDate(file)).getTime()).toBe(capture.capturedAt.getTime());

    const berlin = inBerlin(file);
    expect(berlin.offset).toBe(-120); // the zone really applies in the child
    expect(berlin).toMatchObject({ wall: '2025-06-01T09:45:03', capturedAt: '2025-06-01T07:45:03.000Z' });
    expect(berlin.capturedAt).toBe(berlin.revived);
  });

  it('keeps the offset the camera recorded with it', async () => {
    const file = await jpeg('offset.jpg', { IFD2: { DateTimeOriginal: '2025:06:01 09:45:03', OffsetTimeOriginal: '-05:00' } });
    expect((await extractCapture(file)).wall).toBe('2025-06-01T09:45:03-05:00');
  });

  it('takes the offset that belongs to the tag it read the date from', async () => {
    const file = await jpeg('digitized.jpg', { IFD2: { DateTimeDigitized: '2024:12:24 18:00:00', OffsetTimeDigitized: '+09:00' } });
    expect((await extractCapture(file)).wall).toBe('2024-12-24T18:00:00+09:00');
  });

  it('keeps a time inside the server zone\'s spring-forward gap', async () => {
    const file = await jpeg('gap.jpg', { IFD2: { DateTimeOriginal: '2026:03:29 02:30:00' } });
    const berlin = inBerlin(file);
    expect(berlin.wall).toBe('2026-03-29T02:30:00');
    // The instant is unchanged and shows as 03:30 in the server zone; that
    // is why the wall clock is stored.
    expect(berlin.capturedAt).toBe(berlin.revived);
    expect(berlin.capturedAt).toBe('2026-03-29T01:30:00.000Z');
    expect(berlin.hours).toBe(3);
  });

  it('returns no date and no wall clock for a file without EXIF', async () => {
    const file = await jpeg('none.jpg');
    expect(await extractCapture(file)).toEqual({ capturedAt: null, wall: null });
    expect(await extractCaptureDate(file)).toBeNull();
    expect(captureWallColumn(await extractCapture(file))).toEqual({ captured_at_wall: '' });
  });

  it('returns neither for a date it rejects (blank fields, the future)', async () => {
    const blank = await jpeg('blank.jpg', { IFD2: { DateTimeOriginal: '    :  :     :  :  ' } });
    const future = await jpeg('future.jpg', { IFD2: { DateTimeOriginal: '2099:01:01 00:00:00' } });
    expect(await extractCapture(blank)).toEqual({ capturedAt: null, wall: null });
    expect(await extractCapture(future)).toEqual({ capturedAt: null, wall: null });
  });

  it('returns null for a file it cannot open, and no column for it', async () => {
    const capture = await extractCapture(path.join(tmpDir, 'missing.jpg'));
    expect(capture).toBeNull();
    expect(captureWallColumn(capture)).toEqual({});
    expect(await extractCaptureDate(path.join(tmpDir, 'missing.jpg'))).toBeNull();
  });
});
