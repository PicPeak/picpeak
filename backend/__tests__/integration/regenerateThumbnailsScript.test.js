/**
 * scripts/regenerate-thumbnails.js against external photos (#1148).
 *
 * The same defect #1129 fixed in the admin route, still standing in the CLI
 * fallback: the script resolved every source as
 * `storage/events/active/<photo.path>` and fs.access'd it. External and
 * reference rows do not live there — their originals sit under
 * `events.external_path` — so every one failed the check and was counted as an
 * error. On an install where all photos are external the script did nothing at
 * all, while reporting one error per photo.
 *
 * Driven against a REAL file on a REAL external mount with the real
 * imageProcessor, not a mock: the whole point is that the source resolves off
 * the mount, and a mocked ensureThumbnail would assert nothing about that.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');

describe('regenerate-thumbnails script (#1148)', () => {
  let tmpDir; let db; let cleanup; let regenerateThumbnails;
  let eventId; let externalPhotoId; let videoPhotoId; let watcherVideoId; let repairPhotoId;
  let vanishingPhotoId;
  let externalRoot;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-regen-script-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    // External sources are sandboxed under EXTERNAL_MEDIA_ROOT; event
    // external_path is relative to it, exactly as on a real install.
    process.env.EXTERNAL_MEDIA_ROOT = path.join(tmpDir, 'media');
    externalRoot = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'wedding');

    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    await fs.promises.mkdir(process.env.STORAGE_PATH, { recursive: true });
    await fs.promises.mkdir(externalRoot, { recursive: true });

    jest.resetModules();
    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());

    // A real image on the external mount — never under events/active.
    await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 10, g: 90, b: 160 } },
    }).jpeg().toFile(path.join(externalRoot, 'shot.jpg'));

    const [ev] = await db('events').insert({
      slug: 'regen-script-event',
      event_type: 'wedding',
      event_name: 'Regen Script',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: '/gallery/regen-script-event/share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      source_mode: 'reference',
      external_path: 'wedding',
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId,
      filename: 'shot.jpg',
      // `path` is what the old script joined onto events/active. Left
      // populated on purpose: the fix must ignore it for an external row.
      path: 'regen-script-event/shot.jpg',
      type: 'individual',
      source_origin: 'external',
      external_relpath: 'shot.jpg',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    externalPhotoId = typeof p === 'object' ? p.id : p;

    const [v] = await db('photos').insert({
      event_id: eventId,
      filename: 'clip.mp4',
      path: 'regen-script-event/clip.mp4',
      type: 'individual',
      media_type: 'video',
      mime_type: 'video/mp4',
      source_origin: 'external',
      external_relpath: 'clip.mp4',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    videoPhotoId = typeof v === 'object' ? v.id : v;

    // How fileWatcher.processNewPhoto actually writes a video: `type` and
    // `mime_type` set, media_type left to its 'image' default. A media_type-only
    // filter lets this through and hands the container to Sharp.
    //
    // The file has to EXIST, otherwise the row fails resolution and looks
    // skipped for the wrong reason — the bug is Sharp being handed a video, not
    // a missing source. Real MP4 header bytes, no image in sight.
    await fs.promises.writeFile(
      path.join(externalRoot, 'watched.mp4'),
      Buffer.from('00000018667479706d70343200000000', 'hex')
    );
    const [wv] = await db('photos').insert({
      event_id: eventId,
      filename: 'watched.mp4',
      path: 'regen-script-event/watched.mp4',
      type: 'video',
      mime_type: 'video/mp4',
      source_origin: 'external',
      external_relpath: 'watched.mp4',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    watcherVideoId = typeof wv === 'object' ? wv.id : wv;
    expect((await db('photos').where('id', watcherVideoId).first()).media_type).not.toBe('video');

    // A photo whose thumbnail_path points at something that is no longer there.
    await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
    }).jpeg().toFile(path.join(externalRoot, 'repair.jpg'));
    const [rp] = await db('photos').insert({
      event_id: eventId,
      filename: 'repair.jpg',
      path: 'regen-script-event/repair.jpg',
      type: 'individual',
      thumbnail_path: 'thumbnails/thumb_ext_missing_repair.jpg',
      source_origin: 'external',
      external_relpath: 'repair.jpg',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    repairPhotoId = typeof rp === 'object' ? rp.id : rp;

    // A photo whose source will be removed after its canonical thumbnail is
    // cached — the "mount went away" case, where the canonical rendition is
    // served from cache but a tier still needs to read the original.
    await sharp({
      create: { width: 1000, height: 700, channels: 3, background: { r: 30, g: 140, b: 60 } },
    }).jpeg().toFile(path.join(externalRoot, 'vanishing.jpg'));
    const [vp] = await db('photos').insert({
      event_id: eventId,
      filename: 'vanishing.jpg',
      path: 'regen-script-event/vanishing.jpg',
      type: 'individual',
      source_origin: 'external',
      external_relpath: 'vanishing.jpg',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    vanishingPhotoId = typeof vp === 'object' ? vp.id : vp;

    ({ regenerateThumbnails } = require('../../scripts/regenerate-thumbnails'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('builds a thumbnail for an external photo instead of erroring on events/active', async () => {
    // The location the old script computed and fs.access'd. Nothing is there,
    // which is the whole defect — it is not where an external original lives.
    // (The old script cannot be driven from a test directly: it had no export
    // and ran on require, calling process.exit. Making it importable is part
    // of this fix.)
    const legacyPath = path.join(process.env.STORAGE_PATH, 'events/active', 'regen-script-event/shot.jpg');
    expect(fs.existsSync(legacyPath)).toBe(false);

    const result = await regenerateThumbnails(eventId, { tiers: false });

    // The old script reported an error for this photo and wrote nothing.
    expect(result.errorCount).toBe(0);
    // The external photo, the repair row and the vanishing one; no video.
    expect(result.successCount).toBe(3);

    const row = await db('photos').where('id', externalPhotoId).first();
    expect(row.thumbnail_path).toBeTruthy();
    const onDisk = path.join(process.env.STORAGE_PATH, row.thumbnail_path);
    expect(fs.existsSync(onDisk)).toBe(true);

    // Named per-photo so two events referencing one NAS basename cannot
    // clobber each other — the property ensureThumbnail owns and the reason
    // the script must not build this name itself.
    expect(path.basename(row.thumbnail_path)).toContain(`ext${externalPhotoId}_`);
  });

  it('leaves videos alone', async () => {
    // A video thumbnail is a poster frame from videoProcessor; handing the
    // container to Sharp produced one error per video row.
    const row = await db('photos').where('id', videoPhotoId).first();
    expect(row.thumbnail_path).toBeFalsy();
  });

  it('leaves a watcher-imported video alone, which carries no media_type', async () => {
    // fileWatcher writes type + mime_type and lets media_type default to
    // 'image', so filtering on media_type alone still fed these to Sharp. The
    // signal is errorCount: the images are already done by now, so the only
    // thing that can fail this run is a video reaching Sharp.
    const result = await regenerateThumbnails(eventId, { tiers: false });

    expect(result.errorCount).toBe(0);
    const row = await db('photos').where('id', watcherVideoId).first();
    expect(row.thumbnail_path).toBeFalsy();
  });

  it('is idempotent — a second run skips instead of rebuilding', async () => {
    const before = await db('photos').where('id', externalPhotoId).first();
    const result = await regenerateThumbnails(eventId, { tiers: false });

    expect(result.errorCount).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.skipCount).toBe(3);

    const after = await db('photos').where('id', externalPhotoId).first();
    expect(after.thumbnail_path).toBe(before.thumbnail_path);
  });

  it('counts a repaired thumbnail as generated, not skipped', async () => {
    // Both images are valid at this point. Destroy ONE thumbnail object while
    // leaving thumbnail_path pointing at it — the corrupt/missing case.
    const row = await db('photos').where('id', repairPhotoId).first();
    const onDisk = path.join(process.env.STORAGE_PATH, row.thumbnail_path);
    await fs.promises.rm(onDisk);

    const result = await regenerateThumbnails(eventId, { tiers: false });

    // On local and external storage the rebuilt key is identical, so inferring
    // "skipped" from an unchanged path reports this repair as already valid —
    // the one number an operator running this is actually reading.
    expect(result.successCount).toBe(1);
    expect(result.skipCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('backfills the responsive tiers, which is what a backfill is for', async () => {
    // The tiers (#1095/#1109) are cached separately from thumbnail_path, so a
    // gallery can hold every canonical rendition and still serve phones the
    // full-size image. The old script only ever produced `thumb_<filename>` at
    // a hard-coded 300px and could not backfill them at all.
    const { THUMBNAIL_WIDTHS } = require('../../src/services/imageProcessor');
    const imageRows = 3; // external, repaired and vanishing; videos excluded
    const result = await regenerateThumbnails(eventId, { tiers: true });

    expect(result.errorCount).toBe(0);
    expect(result.tierCount).toBe(THUMBNAIL_WIDTHS.length * imageRows);
    expect(result.tierFailures).toBe(0);
  });

  it('reports tiers it could not build instead of claiming success', async () => {
    // ensureThumbnailAtWidth handles the expected failures itself and returns
    // NULL rather than throwing — an unreachable mount, a storage write that
    // did not land. A try/catch alone never sees those, so the run counted
    // zero errors and printed a clean summary after backfilling nothing.
    //
    // Reproduced the honest way: cache the canonical rendition, then take the
    // source away. The canonical is served from cache; the tiers still need
    // the original.
    const row = await db('photos').where('id', vanishingPhotoId).first();
    expect(row.thumbnail_path).toBeTruthy();

    const { deleteThumbnailTiers } = require('../../src/services/imageProcessor');
    await deleteThumbnailTiers(row).catch(() => {});
    await fs.promises.rm(path.join(externalRoot, 'vanishing.jpg'));

    const result = await regenerateThumbnails(eventId, { tiers: true });

    expect(result.tierFailures).toBeGreaterThan(0);
    // Still not an error against the photo: the canonical rendition is intact
    // and the gallery falls back to it.
    expect(result.errorCount).toBe(0);
  });
});
