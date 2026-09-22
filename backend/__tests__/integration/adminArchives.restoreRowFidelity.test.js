/**
 * Restoring an archive must put every photo back, and put it back as it was.
 *
 * The restore route extracts the whole ZIP, then decides which extracted files
 * deserve a `photos` row by matching the entry name against
 * `/\.(jpg|jpeg|png|gif|webp)$/i`. Everything else lands on disk with no row,
 * which is indistinguishable from deletion: the gallery, the admin grid and
 * every download are built from rows, not from the directory.
 *
 * That silently drops every video and every DNG the event held. Both are
 * first-class uploads with their own MIME entries in `ALLOWED_MEDIA_TYPES`.
 *
 * The rows it does write are also not faithful. `type` is a two-value column
 * ('individual' or 'collage') that the download zip groups folders by, and
 * restore writes the file extension into it, so every restored photo files
 * itself under "Collages". `media_type` is omitted entirely and defaults to
 * 'image', so a restored video stops being a video. `uploaded_at` is stamped
 * with the restore time, reshuffling gallery order.
 *
 * The manifest already carries `type` and `uploaded_at` per photo, and names
 * every photo the event held. These pin it as the source of truth for the row,
 * with the extension set and the directory as the fallbacks that keep
 * pre-manifest archives working.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('archive restore rebuilds the photo row faithfully', () => {
  let tmpDir; let db; let cleanup; let app; let storagePath;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-row-'));
    storagePath = path.join(tmpDir, 'storage');
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.STORAGE_PATH = storagePath;
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    // bootCrmDb points STORAGE_PATH at its own tmp dir; follow it rather than
    // fighting it, so the archives the tests write are where the route looks.
    storagePath = process.env.STORAGE_PATH;
    await fs.promises.mkdir(path.join(storagePath, 'archives'), { recursive: true });

    app = express();
    app.use(express.json());
    app.use('/admin/archives', require('../../src/routes/adminArchives'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('photos').del();
    await db('gallery_guests').del();
    await db('photo_categories').del();
    await db('events').del();
  });

  /** The route only stats the extracted file, so the bytes never have to parse. */
  const BYTES = Buffer.from('not really a media file, and it does not need to be');

  async function writeArchive(name, entries) {
    // Required lazily: the suite calls jest.resetModules() in beforeAll, and
    // archiver's readable-stream copy does not survive being split across the
    // two module registries.
    const archiver = require('archiver');
    const archivePath = path.join(storagePath, 'archives', name);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(archivePath);
      const zip = archiver('zip', { zlib: { level: 0 } });
      output.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(output);
      for (const [entryName, buffer] of Object.entries(entries)) {
        zip.append(buffer, { name: entryName });
      }
      zip.finalize();
    });
    return path.join('archives', name);
  }

  async function seedArchivedEvent(archiveRelPath, slug) {
    const [row] = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-06-27',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `${slug}-share`,
      expires_at: new Date().toISOString(),
      is_archived: 1, // sqlite stores booleans as 0/1, see utils/dbCompat
      archive_path: archiveRelPath,
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  const manifestOf = (rows) => Buffer.from(JSON.stringify(rows), 'utf8');

  const restore = async (eventId) => {
    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);
  };

  const columnByFilename = async (eventId, column) => Object.fromEntries(
    (await db('photos').where('event_id', eventId)).map((p) => [p.filename, p[column]]),
  );

  it('restores a video, which the extension gate drops today', async () => {
    const archiveRelPath = await writeArchive('video.zip', {
      'individual/clip.mp4': BYTES,
      'individual/still.jpg': BYTES,
      'photos_manifest.json': manifestOf([
        { filename: 'clip.mp4', original_filename: 'MVI_0001.mp4', type: 'individual' },
        { filename: 'still.jpg', original_filename: 'DSC_0001.jpg', type: 'individual' },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'video-event');

    await restore(eventId);

    // The whole bug: the jpg came back and the video did not.
    const restored = await db('photos').where('event_id', eventId).pluck('filename');
    expect(restored.sort()).toEqual(['clip.mp4', 'still.jpg']);
  });

  it('restores a DNG, which is an accepted upload the gate does not list', async () => {
    const archiveRelPath = await writeArchive('dng.zip', {
      'individual/raw.dng': BYTES,
      'photos_manifest.json': manifestOf([
        { filename: 'raw.dng', original_filename: 'DSC_0002.dng', type: 'individual' },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'dng-event');

    await restore(eventId);

    expect(await db('photos').where('event_id', eventId).pluck('filename')).toEqual(['raw.dng']);
  });

  it('restores a pre-manifest archive off the extension set alone', async () => {
    // Every archive written before the manifest existed. The extension is the
    // only signal left, and it must still admit what the uploader accepts.
    const archiveRelPath = await writeArchive('legacy.zip', {
      'individual/old.jpg': BYTES,
      'individual/old.mov': BYTES,
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'legacy-event');

    await restore(eventId);

    const restored = await db('photos').where('event_id', eventId).pluck('filename');
    expect(restored.sort()).toEqual(['old.jpg', 'old.mov']);
  });

  it('never turns the archive metadata files into photos', async () => {
    // The guard that widening the gate must not break. archiveService writes
    // all four of these next to the photos.
    const archiveRelPath = await writeArchive('meta.zip', {
      'individual/real.jpg': BYTES,
      'photos_manifest.json': manifestOf([
        { filename: 'real.jpg', original_filename: 'DSC_0003.jpg', type: 'individual' },
      ]),
      'feedback_data.json': BYTES,
      'feedback_data.csv': BYTES,
      'feedback_summary.json': BYTES,
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'meta-event');

    await restore(eventId);

    expect(await db('photos').where('event_id', eventId).pluck('filename')).toEqual(['real.jpg']);
  });

  it('takes type from the manifest instead of writing the file extension', async () => {
    const archiveRelPath = await writeArchive('type.zip', {
      'collages/sheet.jpg': BYTES,
      'individual/single.jpg': BYTES,
      'photos_manifest.json': manifestOf([
        { filename: 'sheet.jpg', original_filename: 'sheet.jpg', type: 'collage' },
        { filename: 'single.jpg', original_filename: 'single.jpg', type: 'individual' },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'type-event');

    await restore(eventId);

    // Both used to be 'jpg', which is neither value the column allows, so the
    // download zip filed every restored photo under "Collages".
    expect(await columnByFilename(eventId, 'type'))
      .toEqual({ 'sheet.jpg': 'collage', 'single.jpg': 'individual' });
  });

  it('falls back to the directory for type when there is no manifest', async () => {
    const archiveRelPath = await writeArchive('typelegacy.zip', {
      'collages/c.jpg': BYTES,
      'individual/i.jpg': BYTES,
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'type-legacy-event');

    await restore(eventId);

    expect(await columnByFilename(eventId, 'type'))
      .toEqual({ 'c.jpg': 'collage', 'i.jpg': 'individual' });
  });

  it('repairs a type the old restore already damaged, from the directory', async () => {
    // An event restored by the old code holds 'jpg' in type. Archive it again
    // and the manifest records 'jpg' faithfully, so trusting any manifest
    // value would write the damage straight back.
    const archiveRelPath = await writeArchive('typedamaged.zip', {
      'collages/sheet.jpg': BYTES,
      'individual/single.jpg': BYTES,
      'photos_manifest.json': manifestOf([
        { filename: 'sheet.jpg', original_filename: 'sheet.jpg', type: 'jpg' },
        { filename: 'single.jpg', original_filename: 'single.jpg', type: 'jpg' },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'type-damaged-event');

    await restore(eventId);

    expect(await columnByFilename(eventId, 'type'))
      .toEqual({ 'sheet.jpg': 'collage', 'single.jpg': 'individual' });
  });

  it('keeps a restored video a video, and a restored photo a photo', async () => {
    const archiveRelPath = await writeArchive('mediatype.zip', {
      'individual/clip.mov': BYTES,
      'individual/still.png': BYTES,
      'photos_manifest.json': manifestOf([
        { filename: 'clip.mov', original_filename: 'clip.mov', type: 'individual' },
        { filename: 'still.png', original_filename: 'still.png', type: 'individual' },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'media-type-event');

    await restore(eventId);

    // media_type defaults to 'image', so omitting it turned every restored
    // video into an image the player would not play.
    expect(await columnByFilename(eventId, 'media_type'))
      .toEqual({ 'clip.mov': 'video', 'still.png': 'image' });
  });

  it('restores a watcher-imported video as a video despite its stale media_type', async () => {
    // fileWatcher sets type='video' and a video/* mime but never media_type,
    // so its rows carry the 'image' column default. Readers know those clips
    // through mime_type alone. The archive writer copies that row as-is, and
    // a restore that trusts the manifest 'image' and drops the mime turns the
    // clip into a photo.
    const archiveRelPath = await writeArchive('watcher.zip', {
      'individual/auto.mp4': BYTES,
      'photos_manifest.json': manifestOf([
        {
          filename: 'auto.mp4',
          original_filename: 'auto.mp4',
          type: 'video',
          media_type: 'image',
          mime_type: 'video/mp4',
        },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'watcher-event');

    await restore(eventId);

    const photo = await db('photos').where('event_id', eventId).first();
    expect(photo.media_type).toBe('video');
    expect(photo.mime_type).toBe('video/mp4');
  });

  it('restores credits, except the name of a guest erased while archived', async () => {
    // Seeded first: the manifest below names the event's guests by id.
    const eventId = await seedArchivedEvent(path.join('archives', 'credits.zip'), 'credits-event');
    const guest = async (name, deleted) => {
      const [row] = await db('gallery_guests').insert({
        event_id: eventId, name, identifier: `g-${name}`, is_deleted: deleted ? 1 : 0,
      }).returning('id');
      return typeof row === 'object' ? row.id : row;
    };
    const anna = await guest('Anna', false);
    const bea = await guest('Removed', true);
    // The manifest is written with the archive, so it predates the erasure.
    const manifest = [
      { filename: 'kept.jpg', type: 'individual', uploaded_by: 'guest', credit_name: 'Anna', credit_source: 'guest', uploader_guest_id: anna },
      { filename: 'erased.jpg', type: 'individual', uploaded_by: 'guest', credit_name: 'Bea', credit_source: 'guest', uploader_guest_id: bea },
      { filename: 'cleared.jpg', type: 'individual', uploaded_by: 'admin', credit_name: null, credit_source: 'manual', uploader_guest_id: null },
    ];
    await writeArchive('credits.zip', {
      'individual/kept.jpg': BYTES,
      'individual/erased.jpg': BYTES,
      'individual/cleared.jpg': BYTES,
      'photos_manifest.json': manifestOf(manifest),
    });

    await restore(eventId);

    const rows = Object.fromEntries((await db('photos').where('event_id', eventId)).map((p) => [p.filename, p]));
    expect(rows['kept.jpg']).toMatchObject({ uploaded_by: 'guest', credit_name: 'Anna', credit_source: 'guest', uploader_guest_id: anna });
    expect(rows['erased.jpg']).toMatchObject({ uploaded_by: 'guest', credit_name: null, credit_source: null, uploader_guest_id: null });
    // A cleared credit stays decided, so the EXIF backfill cannot put one back.
    expect(rows['cleared.jpg']).toMatchObject({ credit_name: null, credit_source: 'manual' });
  });

  it('keeps the original upload time rather than stamping the restore time', async () => {
    const uploadedAt = '2026-06-27T10:30:00.000Z';
    const archiveRelPath = await writeArchive('uploadedat.zip', {
      'individual/first.jpg': BYTES,
      'photos_manifest.json': manifestOf([
        {
          filename: 'first.jpg',
          original_filename: 'first.jpg',
          type: 'individual',
          uploaded_at: uploadedAt,
        },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'uploaded-at-event');

    await restore(eventId);

    // Restoring used to reshuffle the gallery into restore order.
    const photo = await db('photos').where('event_id', eventId).first();
    expect(new Date(photo.uploaded_at).toISOString()).toBe(uploadedAt);
  });

  it('writes an epoch upload time from the manifest back as ISO', async () => {
    // On SQLite a `new Date()` written through knex is stored as epoch
    // milliseconds, and the manifest is JSON.stringify over the raw row, so
    // that shape reaches restore. The old code always wrote an ISO string
    // (the wrong one); keeping the value must not lose the shape.
    const uploadedAt = '2026-06-27T10:30:00.000Z';
    const archiveRelPath = await writeArchive('uploadedatepoch.zip', {
      'individual/epoch.jpg': BYTES,
      'photos_manifest.json': manifestOf([
        {
          filename: 'epoch.jpg',
          original_filename: 'epoch.jpg',
          type: 'individual',
          uploaded_at: new Date(uploadedAt).getTime(),
        },
      ]),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'uploaded-at-epoch-event');

    await restore(eventId);

    const photo = await db('photos').where('event_id', eventId).first();
    expect(photo.uploaded_at).toBe(uploadedAt);
  });
});
