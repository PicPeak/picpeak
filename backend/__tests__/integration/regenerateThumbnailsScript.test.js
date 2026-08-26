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
 *
 * Responsive tiers (#1095/#1109) do not exist on this branch, so the tier
 * backfill in the main twin has nothing to port. Everything else does.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { execFile } = require('child_process');

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
    // External sources are sandboxed under EXTERNAL_MEDIA_ROOT. Rows carry a
    // path relative to that root (#1163), so the 'wedding/' prefix on each
    // external_relpath below is the event folder, not decoration.
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
      external_relpath: 'wedding/shot.jpg',
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
      external_relpath: 'wedding/clip.mp4',
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
      external_relpath: 'wedding/watched.mp4',
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
      external_relpath: 'wedding/repair.jpg',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    repairPhotoId = typeof rp === 'object' ? rp.id : rp;

    // A photo whose source is not on the mount at all — an unavailable mount,
    // which is the failure an operator most needs to hear about.
    const [vp] = await db('photos').insert({
      event_id: eventId,
      filename: 'missing.jpg',
      path: 'regen-script-event/missing.jpg',
      type: 'individual',
      source_origin: 'external',
      external_relpath: 'missing.jpg',
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

    const result = await regenerateThumbnails(eventId);

    // The old script reported an error for this photo and wrote nothing.
    // The unresolvable row fails; the external photo and the repair row build.
    expect(result.errorCount).toBe(1);
    expect(result.successCount).toBe(2);

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
    // NEW thing that could fail this run is a video reaching Sharp. One error
    // is the deliberately unresolvable row; two would be the video.
    const result = await regenerateThumbnails(eventId);

    expect(result.errorCount).toBe(1);
    const row = await db('photos').where('id', watcherVideoId).first();
    expect(row.thumbnail_path).toBeFalsy();
  });

  it('is idempotent — a second run skips instead of rebuilding', async () => {
    const before = await db('photos').where('id', externalPhotoId).first();
    const result = await regenerateThumbnails(eventId);

    expect(result.errorCount).toBe(1);
    expect(result.successCount).toBe(0);
    expect(result.skipCount).toBe(2);

    const after = await db('photos').where('id', externalPhotoId).first();
    expect(after.thumbnail_path).toBe(before.thumbnail_path);
  });

  it('counts a repaired thumbnail as generated, not skipped', async () => {
    // Both images are valid at this point. Destroy ONE thumbnail object while
    // leaving thumbnail_path pointing at it — the corrupt/missing case.
    const row = await db('photos').where('id', repairPhotoId).first();
    const onDisk = path.join(process.env.STORAGE_PATH, row.thumbnail_path);
    await fs.promises.rm(onDisk);

    const result = await regenerateThumbnails(eventId);

    // On local and external storage the rebuilt key is identical, so inferring
    // "skipped" from an unchanged path reports this repair as already valid —
    // the one number an operator running this is actually reading.
    expect(result.successCount).toBe(1);
    expect(result.skipCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  /** Run the CLI the way cron does, and hand back its exit status. */
  const runCli = (args = []) => new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, '..', '..', 'scripts', 'regenerate-thumbnails.js'), ...args],
      { env: { ...process.env }, cwd: path.join(__dirname, '..', '..') },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
    );
  });

  it('exits nonzero when a photo could not be built', async () => {
    // Exit status is the only thing a cron job reads, and `missing.jpg` has no
    // source on the mount.
    const failed = await runCli([String(eventId)]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('completed with failures');
  }, 120000);

  it('exits zero when every photo resolves', async () => {
    // Drop the unresolvable row: a clean run must not cry wolf at automation.
    await db('photos').where('id', vanishingPhotoId).del();
    const ok = await runCli([String(eventId)]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Script completed successfully');
  }, 120000);
});
