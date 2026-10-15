/**
 * Renditions written before derived images were stripped of EXIF (issue
 * 2096) are regenerated in the background, the public OG cover first:
 *  - the pass rebuilds thumbnail, preview and hero, output without EXIF/GPS,
 *    and marks the row (rendition_version)
 *  - the OG cover photo goes first, and the cover endpoint refreshes it once
 *    on request before serving it
 *  - a second pass (a restart) skips rows already done
 *  - trashed photos are left alone; a failed row stays unmarked
 *  - originals are untouched
 */

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('rendition refresh after EXIF stripping', () => {
  let db;
  let cleanup;
  let taggedJpeg;
  let counter = 0;
  let imageProcessor;
  let refresh;

  const storagePath = (...parts) => path.join(process.env.STORAGE_PATH, ...parts);
  const exists = (key) => fs.existsSync(storagePath(key));
  const passOptions = { active: () => true, sleep: async () => {} };

  async function writeKey(key, bytes) {
    await fs.promises.mkdir(path.dirname(storagePath(key)), { recursive: true });
    await fs.promises.writeFile(storagePath(key), bytes);
  }

  async function makeEvent(fields = {}) {
    counter += 1;
    const slug = `rendition-refresh-${counter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Rendition Refresh ${counter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `rendition-refresh-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
      ...fields,
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    return db('events').where({ id }).first();
  }

  // A photo as it looked before the fix: the original and every stored
  // rendition carry GPS, Make and Copyright.
  async function addLegacyPhoto(event, { renditions = ['thumbnail'], ...fields } = {}) {
    counter += 1;
    const filename = `legacy-${counter}.jpg`;
    await writeKey(path.posix.join('events/active', event.slug, filename), taggedJpeg);
    const row = {
      event_id: event.id,
      filename,
      original_filename: filename,
      path: `${event.slug}/${filename}`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      size_bytes: taggedJpeg.length,
      processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
      rendition_version: 0,
      ...fields,
    };
    if (renditions.includes('thumbnail')) row.thumbnail_path = `thumbnails/thumb_old_${filename}`;
    if (renditions.includes('preview')) row.preview_path = `previews/preview_old_${filename}`;
    if (renditions.includes('hero')) row.hero_path = `heroes/hero_old_${filename}`;
    for (const key of [row.thumbnail_path, row.preview_path, row.hero_path].filter(Boolean)) {
      await writeKey(key, taggedJpeg);
    }
    const r = await db('photos').insert(row).returning('id');
    return r[0]?.id ?? r[0];
  }

  const expectStripped = async (key) => {
    expect(key).toBeTruthy();
    const out = await sharp(storagePath(key)).metadata();
    expect(out.exif).toBeUndefined();
    expect(out.xmp).toBeUndefined();
    expect(out.iptc).toBeUndefined();
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    process.env.RENDITION_REFRESH_PAUSE_MS = '0';
    taggedJpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 120, g: 80, b: 40 } } })
      .withExif({
        IFD0: { Make: 'SecretCam', Copyright: 'Jane Doe' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 30/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '13/1 24/1 0/1' },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(taggedJpeg).metadata()).exif.toString('latin1')).toContain('SecretCam');
    imageProcessor = require('../../src/services/imageProcessor');
    refresh = require('../../src/services/renditionRefresh');
  }, 120000);

  beforeEach(async () => {
    // Every case starts from a library with nothing left to do.
    await db('photos').update({ rendition_version: refresh.RENDITION_VERSION });
    await db('maintenance_jobs').where({ job_name: refresh.JOB_NAME }).del();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    delete process.env.RENDITION_REFRESH_PAUSE_MS;
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
  });

  it('a new row starts at the current version and re-running migration 311 resets nothing', async () => {
    const event = await makeEvent();
    const r = await db('photos').insert({
      event_id: event.id, filename: 'fresh.jpg', original_filename: 'fresh.jpg', path: `${event.slug}/fresh.jpg`,
      type: 'individual', media_type: 'image', mime_type: 'image/jpeg', processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    const id = r[0]?.id ?? r[0];
    expect(Number((await db('photos').where({ id }).first()).rendition_version)).toBe(refresh.RENDITION_VERSION);

    // Re-running up() finds the column and does not reset refreshed rows.
    const migration = require('../../migrations/core/311_photos_rendition_version');
    await migration.up(db);
    expect(Number((await db('photos').where({ id }).first()).rendition_version)).toBe(refresh.RENDITION_VERSION);
  });

  it('regenerates every stored rendition without EXIF, cover first, and marks the rows', async () => {
    const event = await makeEvent({ og_image_share_enabled: true });
    // Inserted first, so a walk by id alone would reach it before the cover.
    const other = await addLegacyPhoto(event, { renditions: ['thumbnail', 'preview', 'hero'] });
    const cover = await addLegacyPhoto(event);
    await db('events').where({ id: event.id }).update({ hero_photo_id: cover });
    const trashed = await addLegacyPhoto(event, { deleted_at: new Date().toISOString() });
    const before = await db('photos').whereIn('id', [other, cover]).select('id', 'path', 'thumbnail_path', 'preview_path', 'hero_path');

    const ensureThumbnail = jest.spyOn(imageProcessor, 'ensureThumbnail');

    const counts = await refresh.runPass(passOptions);
    expect(counts).toEqual({ refreshed: 2, failed: 0 });
    expect(ensureThumbnail.mock.calls.map(([photo]) => photo.id)).toEqual([cover, other]);

    const rows = await db('photos').whereIn('id', [other, cover, trashed]).select();
    const byId = Object.fromEntries(Array.from(rows).map((row) => [row.id, row]));
    expect(Number(byId[cover].rendition_version)).toBe(refresh.RENDITION_VERSION);
    expect(Number(byId[other].rendition_version)).toBe(refresh.RENDITION_VERSION);
    await expectStripped(byId[cover].thumbnail_path);
    await expectStripped(byId[other].thumbnail_path);
    await expectStripped(byId[other].preview_path);
    await expectStripped(byId[other].hero_path);

    // The superseded legacy files are gone; the originals are untouched.
    for (const row of before) {
      for (const key of [row.thumbnail_path, row.preview_path, row.hero_path].filter(Boolean)) {
        expect(exists(key)).toBe(false);
      }
      expect(fs.readFileSync(storagePath('events/active', row.path)).equals(taggedJpeg)).toBe(true);
    }

    // The trashed photo is skipped: still unmarked, its rendition unchanged.
    expect(Number(byId[trashed].rendition_version)).toBe(0);
    expect(fs.readFileSync(storagePath(byId[trashed].thumbnail_path)).equals(taggedJpeg)).toBe(true);

    const status = await refresh.status();
    expect(status.isRunning).toBe(false);
    expect(status.lastResult).toEqual({ refreshed: 2, failed: 0 });
  }, 60000);

  it('resumes: a second pass skips rows already done and retries a failed one', async () => {
    const event = await makeEvent();
    const done = await addLegacyPhoto(event);
    const failing = await addLegacyPhoto(event);
    // The original of this one is missing, so nothing can be regenerated.
    const failingRow = await db('photos').where({ id: failing }).first();
    fs.rmSync(storagePath('events/active', failingRow.path));

    expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 1, failed: 1 });
    expect(Number((await db('photos').where({ id: done }).first()).rendition_version)).toBe(refresh.RENDITION_VERSION);
    const stillFailing = await db('photos').where({ id: failing }).first();
    expect(Number(stillFailing.rendition_version)).toBe(0);
    // Its old rendition stays where it was; nothing pointed at nothing.
    expect(stillFailing.thumbnail_path).toBe(failingRow.thumbnail_path);

    const ensureThumbnail = jest.spyOn(imageProcessor, 'ensureThumbnail');
    expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 0, failed: 1 });
    expect(ensureThumbnail.mock.calls.map(([photo]) => photo.id)).toEqual([failing]);
  }, 60000);

  it('never deletes a file outside the rendition namespace a legacy pointer names', async () => {
    const event = await makeEvent();
    const id = await addLegacyPhoto(event);
    const row = await db('photos').where({ id }).first();
    // A legacy row whose thumbnail column points at the original itself.
    const originalKey = path.posix.join('events/active', row.path);
    await db('photos').where({ id }).update({ thumbnail_path: originalKey });

    expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 1, failed: 0 });
    const after = await db('photos').where({ id }).first();
    expect(after.thumbnail_path).not.toBe(originalKey);
    await expectStripped(after.thumbnail_path);
    expect(fs.readFileSync(storagePath(originalKey)).equals(taggedJpeg)).toBe(true);
  }, 60000);

  // Each case its own file, so an earlier case's rows cannot keep it.
  it.each(['./previews/%s', 'previews\\%s', 'previews/./%s', 'previews//%s'])(
    'keeps a superseded rendition a trashed row still names as %s', async (shape) => {
      const event = await makeEvent();
      const id = await addLegacyPhoto(event, { renditions: ['preview'] });
      const name = `preview_shared_${counter}.jpg`;
      const key = `previews/${name}`;
      const spelling = shape.replace('%s', name);
      await db('photos').where({ id }).update({ preview_path: key });
      await writeKey(key, taggedJpeg);
      const other = await addLegacyPhoto(event, { renditions: [], deleted_at: new Date().toISOString() });
      await db('photos').where({ id: other }).update({ preview_path: spelling });

      expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 1, failed: 0 });
      expect((await db('photos').where({ id }).first()).preview_path).not.toBe(key);
      expect(exists(key)).toBe(true);
    }, 60000);

  it('reads the references once per pass and deletes a shared file after its last row moves off', async () => {
    const event = await makeEvent();
    const key = `previews/preview_pair_${counter}.jpg`;
    const first = await addLegacyPhoto(event, { renditions: ['preview'] });
    const second = await addLegacyPhoto(event, { renditions: ['preview'] });
    await db('photos').whereIn('id', [first, second]).update({ preview_path: key });
    await writeKey(key, taggedJpeg);

    const { db: appDb } = require('../../src/database/db');
    let scans = 0;
    const onQuery = (q) => {
      if (/hero_path.* from [`"]photos[`"] where [`"]id[`"] > \? order by [`"]id[`"]/i.test(q.sql)) scans++;
    };
    appDb.on('query', onQuery);
    try {
      expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 2, failed: 0 });
    } finally {
      appDb.removeListener('query', onQuery);
    }
    // Two pages at most for this library (rows, then the empty page).
    expect(scans).toBeLessThanOrEqual(2);
    expect(scans).toBeGreaterThan(0);
    expect(exists(key)).toBe(false);
  }, 60000);

  it('does not trust a reference scan that failed half-way', async () => {
    const event = await makeEvent();
    const pair = async () => {
      const key = `previews/preview_kept_${counter}.jpg`;
      const id = await addLegacyPhoto(event, { renditions: ['preview'] });
      const trashed = await addLegacyPhoto(event, { renditions: [], deleted_at: new Date().toISOString() });
      await db('photos').whereIn('id', [id, trashed]).update({ preview_path: key });
      await writeKey(key, taggedJpeg);
      return key;
    };
    const firstKey = await pair();
    const secondKey = await pair();

    const { db: appDb } = require('../../src/database/db');
    const realQuery = appDb.client.query;
    let failNext = true;
    appDb.client.query = function (connection, obj) {
      if (failNext && /hero_path.* from [`"]photos[`"] where [`"]id[`"] > \?/i.test(obj.sql)) {
        failNext = false;
        return Promise.reject(new Error('connection reset'));
      }
      return realQuery.call(this, connection, obj);
    };
    try {
      expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 2, failed: 0 });
    } finally {
      appDb.client.query = realQuery;
    }
    // Both files are still named by a trashed row, so both stay.
    expect(exists(firstKey)).toBe(true);
    expect(exists(secondKey)).toBe(true);
  }, 60000);

  it('drops the tiers a RAW photo was actually served under (its attempt names them)', async () => {
    const event = await makeEvent();
    const id = await addLegacyPhoto(event, { processing_attempt_id: 'attempt-2096' });
    await db('photos').where({ id }).update({ filename: 'legacy.cr2', path: `${event.slug}/legacy.cr2` });
    const full = await db('photos').where({ id }).first();
    const storage = require('../../src/services/storage').getStorage();
    const deleted = jest.spyOn(storage, 'delete');

    await refresh.runPass(passOptions);
    const keys = deleted.mock.calls.map(([key]) => key);
    expect(keys).toEqual(expect.arrayContaining([
      ...imageProcessor.thumbnailTierKeys(full), ...imageProcessor.previewTierKeys(full),
    ]));
  }, 60000);

  it('does not mark a photo whose old tier could not be deleted', async () => {
    const event = await makeEvent();
    const id = await addLegacyPhoto(event);
    const full = await db('photos').where({ id }).first();
    const tier = imageProcessor.thumbnailTierKeys(full)[0];
    await writeKey(tier, taggedJpeg);
    const storage = require('../../src/services/storage').getStorage();
    const realDelete = storage.delete.bind(storage);
    jest.spyOn(storage, 'delete').mockImplementation(async (key) => {
      if (key === tier) throw Object.assign(new Error('storage unavailable'), { code: 'EIO' });
      return realDelete(key);
    });

    expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 0, failed: 1 });
    expect(Number((await db('photos').where({ id }).first()).rendition_version)).toBe(0);
    expect(exists(tier)).toBe(true);
  }, 60000);

  describe('a files restore that puts back renditions', () => {
    beforeAll(() => { process.env.RENDITION_REFRESH_DISABLED = 'true'; });
    afterAll(() => { delete process.env.RENDITION_REFRESH_DISABLED; });

    it('un-marks the photos whose rendition or tier came back, and only those', async () => {
      const event = await makeEvent();
      const byColumn = await addLegacyPhoto(event, { renditions: ['thumbnail', 'preview'] });
      const byTier = await addLegacyPhoto(event);
      const trashed = await addLegacyPhoto(event, { renditions: ['preview'], deleted_at: new Date().toISOString() });
      const untouched = await addLegacyPhoto(event);
      await db('photos').whereIn('id', [byColumn, byTier, trashed, untouched]).update({ rendition_version: 1 });
      const preview = (await db('photos').where({ id: byColumn }).first()).preview_path;
      const trashedPreview = (await db('photos').where({ id: trashed }).first()).preview_path;

      const reset = await refresh.invalidateRestoredRenditions([
        `./${preview}`,                                   // a canonical rendition, legacy spelling
        `thumbnails/thumb_w600_p${byTier}_legacy.jpg`,   // a tier, named after its photo
        trashedPreview,
        'thumbnails/thumb_nobody.jpg',                   // a rendition no row names
        'events/active/some/original.jpg',               // not a rendition
      ]);
      expect(reset).toBe(3);
      const versions = Object.fromEntries(Array.from(await db('photos')
        .whereIn('id', [byColumn, byTier, trashed, untouched]).select('id', 'rendition_version'))
        .map((r) => [r.id, Number(r.rendition_version)]));
      expect(versions).toEqual({ [byColumn]: 0, [byTier]: 0, [trashed]: 0, [untouched]: 1 });
    });

    it('restoreService un-marks a photo after a files restore of its old thumbnail, not after a full restore', async () => {
      const event = await makeEvent();
      const id = await addLegacyPhoto(event);
      await db('photos').where({ id }).update({ rendition_version: 1 });
      const { thumbnail_path: key } = await db('photos').where({ id }).first();

      const crypto = require('crypto');
      const backupRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'picpeak-rv-restore-'));
      fs.mkdirSync(path.join(backupRoot, path.dirname(key)), { recursive: true });
      fs.writeFileSync(path.join(backupRoot, key), taggedJpeg);
      const manifest = { files: { manifest: [{
        path: key, size: taggedJpeg.length, checksum: crypto.createHash('sha256').update(taggedJpeg).digest('hex'),
      }] } };
      const { restoreService } = require('../../src/services/restoreService');
      try {
        const result = await restoreService.performFilesRestore(backupRoot, manifest, { restoreType: 'files' });
        expect(result.restoredPaths).toEqual([key]);

        await restoreService.markRestoredRenditions({ restoreType: 'full' }, result);
        expect(Number((await db('photos').where({ id }).first()).rendition_version)).toBe(1);

        await restoreService.markRestoredRenditions({ restoreType: 'files' }, result);
        expect(Number((await db('photos').where({ id }).first()).rendition_version)).toBe(0);
      } finally {
        fs.rmSync(backupRoot, { recursive: true, force: true });
      }
    }, 60000);
  });

  it('requestPass runs a pass after the boot-time one has finished', async () => {
    const event = await makeEvent();
    const id = await addLegacyPhoto(event);
    process.env.RENDITION_REFRESH_DELAY_MS = '0';
    try {
      refresh.requestPass();
      const deadline = Date.now() + 20000;
      while (Number((await db('photos').where({ id }).first()).rendition_version) !== refresh.RENDITION_VERSION) {
        if (Date.now() > deadline) throw new Error('no pass ran');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      delete process.env.RENDITION_REFRESH_DELAY_MS;
      await refresh.stop();
    }
  }, 30000);

  it('a full or database restore asks for a pass once its migrations ran', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/services/restoreService.js'), 'utf8');
    const migrate = source.indexOf('migrations/run-migrations-safe.js');
    const request = source.indexOf('renditionRefresh\').requestPass()');
    expect(migrate).toBeGreaterThan(0);
    expect(request).toBeGreaterThan(migrate);
    expect(source.slice(request - 300, request)).toMatch(/'full' \|\| options\.restoreType === 'database'\) && migrationsApplied/);
  });

  it('does not run while another replica holds the claim', async () => {
    const event = await makeEvent();
    await addLegacyPhoto(event);
    const maintenanceJobs = require('../../src/services/maintenanceJobState');
    await maintenanceJobs.ensure(refresh.JOB_NAME);
    const token = await maintenanceJobs.claim(refresh.JOB_NAME);
    expect(token).toBeTruthy();
    expect(await refresh.runPass(passOptions)).toBe('busy');
    await maintenanceJobs.release(refresh.JOB_NAME, token);
  });

  it('the OG cover endpoint regenerates a legacy cover once and serves it without EXIF', async () => {
    const event = await makeEvent({ og_image_share_enabled: true });
    const cover = await addLegacyPhoto(event);
    await db('events').where({ id: event.id }).update({ hero_photo_id: cover });
    const { handleGalleryOgCover } = require('../../src/services/galleryOgService');
    const ensureThumbnail = jest.spyOn(imageProcessor, 'ensureThumbnail');

    const fetchCover = () => new Promise((resolve, reject) => {
      const res = new PassThrough();
      const chunks = [];
      res.statusCode = 200;
      res.headers = {};
      res.status = (code) => { res.statusCode = code; return res; };
      res.type = () => res;
      res.set = (headers) => { Object.assign(res.headers, headers); return res; };
      res.setHeader = (name, value) => { res.headers[name] = value; };
      res.send = (body) => resolve({ status: res.statusCode, body: Buffer.from(String(body)) });
      res.end = () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('finish', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
      handleGalleryOgCover({ params: { slug: event.slug }, headers: {} }, res).catch(reject);
    });

    const first = await fetchCover();
    expect(first.status).toBe(200);
    expect((await sharp(first.body).metadata()).exif).toBeUndefined();
    const forced = () => ensureThumbnail.mock.calls.filter(([, options]) => options && options.force).length;
    expect(forced()).toBe(1);
    expect(Number((await db('photos').where({ id: cover }).first()).rendition_version)).toBe(refresh.RENDITION_VERSION);

    const second = await fetchCover();
    expect(second.status).toBe(200);
    expect(forced()).toBe(1);

    // The background pass has nothing left to do for it.
    expect(await refresh.runPass(passOptions)).toEqual({ refreshed: 0, failed: 0 });
  }, 60000);

  it('the OG cover endpoint does not serve a legacy cover it could not regenerate', async () => {
    const event = await makeEvent({ og_image_share_enabled: true });
    const cover = await addLegacyPhoto(event);
    await db('events').where({ id: event.id }).update({ hero_photo_id: cover });
    const row = await db('photos').where({ id: cover }).first();
    fs.rmSync(storagePath('events/active', row.path));
    const { handleGalleryOgCover } = require('../../src/services/galleryOgService');

    const res = { status: jest.fn(() => res), type: jest.fn(() => res), send: jest.fn(), set: jest.fn(), setHeader: jest.fn() };
    await handleGalleryOgCover({ params: { slug: event.slug }, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(Number((await db('photos').where({ id: cover }).first()).rendition_version)).toBe(0);
  }, 60000);
});
