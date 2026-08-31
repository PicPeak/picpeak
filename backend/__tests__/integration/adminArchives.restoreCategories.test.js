/**
 * Restoring an archive must put the photos back into their categories.
 *
 * The archive writer already persists `category_name` per photo in
 * `photos_manifest.json` — that is why the manifest exists, and the comment
 * above it says so: "(and category linkage) can't be derived from the
 * extracted files alone". The restore route then read only
 * `original_filename` from it and kept deriving the category from the ZIP's
 * first path segment.
 *
 * Archives store photos exactly as they sit on disk, so an event whose photos
 * live in the gallery root produces a FLAT zip. `path.dirname()` is '.' for
 * every entry, no category is resolved, and every restored photo lands with
 * `category_id = null` — silently, with a 200 response.
 *
 * These pin the manifest as the source of truth, with the directory as the
 * fallback that keeps foldered and legacy archives working.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('archive restore restores categories (flat archives included)', () => {
  let tmpDir; let db; let cleanup; let app; let storagePath;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-cat-'));
    storagePath = path.join(tmpDir, 'storage');
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.STORAGE_PATH = storagePath;
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    await fs.promises.mkdir(path.join(storagePath, 'archives'), { recursive: true });

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
    await db('photo_categories').del();
    await db('events').del();
  });

  /** A one-pixel JPEG is enough; the route only stats the extracted file. */
  const PIXEL = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
    + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
    + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  );

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
      is_archived: 1,  // sqlite stores booleans as 0/1, see utils/dbCompat
      archive_path: archiveRelPath,
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  const categoryOf = async (filename) => {
    const photo = await db('photos').where('filename', filename).first();
    if (!photo || !photo.category_id) return null;
    const category = await db('photo_categories').where('id', photo.category_id).first();
    return category ? category.name : null;
  };

  it('takes the category from the manifest when the archive is flat', async () => {
    // Exactly the shape a gallery-root event archives to: no directories.
    const manifest = JSON.stringify([
      { filename: 'a.jpg', original_filename: 'DSC_0001.jpg', category_name: 'Polterabend' },
      { filename: 'b.jpg', original_filename: 'DSC_0002.jpg', category_name: 'Ceremony' },
    ]);
    const archiveRelPath = await writeArchive('flat.zip', {
      'a.jpg': PIXEL,
      'b.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(manifest, 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'flat-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    // The whole bug: both of these used to be null.
    expect(await categoryOf('a.jpg')).toBe('Polterabend');
    expect(await categoryOf('b.jpg')).toBe('Ceremony');
  });

  it('reuses an existing category row instead of creating a duplicate', async () => {
    const archiveRelPath = await writeArchive('reuse.zip', {
      'c.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'c.jpg', original_filename: 'DSC_0003.jpg', category_name: 'Party' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'reuse-event');
    await db('photo_categories').insert({
      event_id: eventId, name: 'Party', slug: 'party', created_at: new Date(),
    });

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    expect(await categoryOf('c.jpg')).toBe('Party');
    const rows = await db('photo_categories').where({ event_id: eventId, name: 'Party' });
    expect(rows).toHaveLength(1);
  });

  it('still falls back to the directory for legacy archives with no manifest', async () => {
    // No manifest at all — the shape every archive had before the manifest
    // landed. The directory is the only signal left, and it must keep working.
    //
    // `individual/` is what a REAL archive contains: entry names are the
    // storage key minus `events/active/{slug}`, and that layout is
    // `individual/` / `collages/`. Categories have never been directories, so
    // the fallback invents a category with that name — not useful, but better
    // than losing every category, and this pins what actually happens rather
    // than a category-shaped folder no archive produces.
    const archiveRelPath = await writeArchive('foldered.zip', {
      'individual/d.jpg': PIXEL,
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'foldered-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    expect(await categoryOf('d.jpg')).toBe('individual');
  });

  it('reuses a GLOBAL category instead of cloning it into the event', async () => {
    // Seeded categories (Ceremony, Reception, ...) have event_id NULL. An
    // event-only lookup misses them, so the restore used to create a second
    // "Ceremony" — and because is_global defaults to TRUE, that duplicate then
    // appeared in every other event's category list.
    const [g] = await db('photo_categories').insert({
      event_id: null, name: 'Ceremony', slug: 'ceremony', is_global: true, created_at: new Date(),
    }).returning('id');
    const globalId = typeof g === 'object' ? g.id : g;

    const archiveRelPath = await writeArchive('global.zip', {
      'individual/gl.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'gl.jpg', original_filename: 'DSC_1.jpg', category_name: 'Ceremony' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'global-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    const photo = await db('photos').where('filename', 'gl.jpg').first();
    expect(photo.category_id).toBe(globalId);
    // No clone, global or otherwise.
    const all = await db('photo_categories').where('name', 'Ceremony');
    expect(all).toHaveLength(1);
  });

  it('does not create a GLOBAL category when it has to invent one', async () => {
    // is_global defaults to true on this column, so an unqualified insert would
    // leak a restore's category name into every gallery on the instance.
    const archiveRelPath = await writeArchive('newcat.zip', {
      'individual/nc.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'nc.jpg', original_filename: 'DSC_2.jpg', category_name: 'Polterabend' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'newcat-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    const created = await db('photo_categories').where('name', 'Polterabend').first();
    expect(created.event_id).toBe(eventId);
    expect(created.is_global === false || created.is_global === 0).toBe(true);
  });

  it('matches the manifest when the ZIP was written with original filenames', async () => {
    // With general_use_original_filenames_for_downloads on at archive time,
    // archiveService names entries after the ORIGINAL filename while the
    // manifest stays keyed by photos.filename. Looking up the extracted
    // basename missed every entry, so categories were lost on exactly those
    // archives.
    const archiveRelPath = await writeArchive('original-names.zip', {
      'individual/DSC_4242.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'stored_9f8e7d.jpg', original_filename: 'DSC_4242.jpg', category_name: 'Drohne' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'original-names-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    expect(await categoryOf('DSC_4242.jpg')).toBe('Drohne');
  });

  it('prefers the event-scoped category when a global shares its name', async () => {
    // The category API permits both. A single OR-lookup with .first() returned
    // whichever the engine chose, so a photo could be reassigned to the global
    // row and lose event-local settings such as allow_downloads.
    const archiveRelPath = await writeArchive('collide.zip', {
      'individual/co.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'co.jpg', original_filename: 'DSC_3.jpg', category_name: 'Reception' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'collide-event');

    await db('photo_categories').insert({
      event_id: null, name: 'Reception', slug: 'reception-global', is_global: true, created_at: new Date(),
    });
    const [own] = await db('photo_categories').insert({
      event_id: eventId, name: 'Reception', slug: 'reception-own', is_global: false, created_at: new Date(),
    }).returning('id');
    const ownId = typeof own === 'object' ? own.id : own;

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    const photo = await db('photos').where('filename', 'co.jpg').first();
    expect(photo.category_id).toBe(ownId);
  });

  it('matches a sanitized original filename, as the ZIP would have written it', async () => {
    // archiveService runs original names through sanitizeForZipEntry() before
    // writing the entry, so the emitted name differs from the manifest column.
    const archiveRelPath = await writeArchive('sanitized.zip', {
      'individual/od_dr_DSC_5.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'stored_abc.jpg', original_filename: 'od/dr/DSC_5.jpg', category_name: 'Strand' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'sanitized-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    expect(await categoryOf('od_dr_DSC_5.jpg')).toBe('Strand');
  });

  it('ignores a legacy event-owned row when falling back to globals', async () => {
    // The bug fixed here left rows behind on upgraded instances: event-owned
    // AND is_global true, because the column defaults true. Matching on the
    // flag alone would let one event's leftover be adopted by another event's
    // restore, tying photos to a category that vanishes with someone else's
    // gallery.
    const otherEventId = await seedArchivedEvent('archives/none.zip', 'legacy-owner-event');
    await db('photo_categories').insert({
      event_id: otherEventId, name: 'Sunset', slug: 'sunset-legacy',
      is_global: true, created_at: new Date(),
    });

    const archiveRelPath = await writeArchive('legacy-global.zip', {
      'individual/lg.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'lg.jpg', original_filename: 'DSC_6.jpg', category_name: 'Sunset' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'legacy-global-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    const photo = await db('photos').where('filename', 'lg.jpg').first();
    const cat = await db('photo_categories').where('id', photo.category_id).first();
    // Its own row, not the other event's leftover.
    expect(cat.event_id).toBe(eventId);
  });

  it('drops an ambiguous original-name alias rather than guessing', async () => {
    // Two photos in different ZIP folders can share an original basename;
    // archiveService treats the paths as distinct and suffixes neither. Both
    // would collapse onto one alias, and whichever won would hand the other
    // photo someone else's category.
    const archiveRelPath = await writeArchive('ambiguous.zip', {
      'individual/SHARED.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'a_stored.jpg', original_filename: 'SHARED.jpg', category_name: 'Alpha' },
        { filename: 'b_stored.jpg', original_filename: 'SHARED.jpg', category_name: 'Beta' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'ambiguous-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    // Falls back to the directory rather than picking Alpha or Beta at random.
    expect(await categoryOf('SHARED.jpg')).toBe('individual');
    for (const name of ['Alpha', 'Beta']) {
      expect(await db('photo_categories').where({ event_id: eventId, name }).first()).toBeFalsy();
    }
  });

  it('honours a manifest that says UNCATEGORIZED, instead of inventing one from the directory', async () => {
    // The case the manifest-first change was for. A real archive puts every
    // photo under `individual/`, so a photo the manifest records as having no
    // category used to come back filed under a category called "individual" —
    // the manifest being authoritative for "category X" but not for "none".
    const manifest = JSON.stringify([
      { filename: 'u.jpg', original_filename: 'DSC_7000.jpg', category_name: null },
    ]);
    const archiveRelPath = await writeArchive('uncategorized.zip', {
      'individual/u.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(manifest, 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'uncategorized-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    expect(await categoryOf('u.jpg')).toBeNull();
    // And no junk category row was created as a side effect.
    const rows = await db('photo_categories').where({ event_id: eventId });
    expect(rows).toHaveLength(0);
  });

  it('drops a canonical filename that two photos claim, rather than guessing', async () => {
    // photos.filename is not unique within an event: s3AutoImporter takes
    // path.basename(entry.key) and dedupes by path, so two imported files in
    // different subfolders both land as IMG_1234.jpg. Both ZIP entries reduce
    // to the same basename at restore, so keeping the last row seen would give
    // one photo the other's category.
    const archiveRelPath = await writeArchive('dup-canonical.zip', {
      'individual/IMG_1234.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'IMG_1234.jpg', original_filename: 'a.jpg', category_name: 'Alpha' },
        { filename: 'IMG_1234.jpg', original_filename: 'b.jpg', category_name: 'Beta' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'dup-canonical-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    expect(await categoryOf('IMG_1234.jpg')).toBe('individual');
    for (const name of ['Alpha', 'Beta']) {
      expect(await db('photo_categories').where({ event_id: eventId, name }).first()).toBeFalsy();
    }
  });

  it("keeps a canonical filename when another row's original_filename collides with it", async () => {
    // The alias pass must not be able to evict a canonical key. Previously the
    // outcome depended on manifest iteration order — the archive query has no
    // ORDER BY — so the canonical row lost its category roughly half the time.
    const archiveRelPath = await writeArchive('alias-vs-canonical.zip', {
      'individual/CANON.jpg': PIXEL,
      'photos_manifest.json': Buffer.from(JSON.stringify([
        { filename: 'CANON.jpg', original_filename: 'unrelated.jpg', category_name: 'Canonical' },
        { filename: 'other_stored.jpg', original_filename: 'CANON.jpg', category_name: 'Aliased' },
      ]), 'utf8'),
    });
    const eventId = await seedArchivedEvent(archiveRelPath, 'alias-vs-canonical-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    // The canonical row owns the name; the alias never gets to claim or drop it.
    expect(await categoryOf('CANON.jpg')).toBe('Canonical');
  });

});
