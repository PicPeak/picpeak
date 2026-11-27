/**
 * Archiving a gallery after a guest used "Download all" put the cached
 * download zip into the archive, so every photo was stored twice. The cache
 * lives under the gallery's own folder (.download-cache/all.zip) and the
 * archive takes every file under that folder.
 *
 * Restore also writes the archive's metadata files back into the gallery
 * folder, so the next archive listed the restored photos_manifest.json and
 * then appended a fresh one under the same name: two entries, one stale.
 *
 * Both run against the local storage backend, which lists the hidden cache
 * folder the same way S3 does.
 */

const path = require('path');
const express = require('express');
const request = require('supertest');
const StreamZip = require('node-stream-zip');

jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => undefined),
  getSupportEmail: jest.fn(async () => 'support@example.com'),
}));

describe('gallery archive and the download-all cache', () => {
  let db; let cleanup; let storage; let app; let archiveEvent; let downloadZipService;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  beforeAll(async () => {
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => {
        req.admin = { id: 1, username: 'tester' };
        require('../../src/database/crmAccess').withTrustedCrmAccess('archive cache fixture authentication', next);
      },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
      requireEventOwner: (_req, _res, next) => next(),
    }));

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    storage = require('../../src/services/storage').getStorage();
    ({ archiveEvent } = require('../../src/services/archiveService'));
    downloadZipService = require('../../src/services/downloadZipService');

    app = express();
    app.use(express.json());
    app.use('/admin/archives', require('../../src/routes/adminArchives'));
  }, 180000);

  afterAll(async () => {
    if (downloadZipService) await downloadZipService.stop();
    if (cleanup) await cleanup();
  });

  beforeEach(() => {
    require('../../src/database/crmAccess').enterTrustedCrmFixtureContext();
  });

  async function makeEvent(slug, photoCount) {
    const id = unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Archive ${slug}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() - 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
    for (let i = 0; i < photoCount; i += 1) {
      const filename = `photo-${i}.jpg`;
      const key = `events/active/${slug}/individual/${filename}`;
      const bytes = Buffer.from(`photo ${i} of ${slug}`);
      await storage.put(key, bytes, { contentType: 'image/jpeg' });
      await db('photos').insert({
        event_id: id, filename, path: key, type: 'individual', size_bytes: bytes.length,
        source_origin: 'managed', mime_type: 'image/jpeg', uploaded_at: new Date().toISOString(),
      });
    }
    return id;
  }

  // entries() is keyed by name and folds duplicates together, so the count
  // comes from the central directory and a repeated name shows up as `dup:`.
  async function zipEntryNames(key) {
    const zip = new StreamZip.async({ file: path.join(process.env.STORAGE_PATH, key) });
    try {
      const names = Object.values(await zip.entries()).filter((e) => !e.isDirectory).map((e) => e.name).sort();
      const count = await zip.entriesCount;
      return count === names.length ? names : [...names, `dup: ${count - names.length}`];
    } finally {
      await zip.close();
    }
  }

  it('leaves the download-all zip out of the archive and removes it', async () => {
    const slug = 'cached-gallery';
    const id = await makeEvent(slug, 3);
    const built = await downloadZipService.generateZip(id);
    expect(built).toMatchObject({ success: true });
    const cacheKey = downloadZipService.getCacheKey(slug);
    expect(await storage.exists(cacheKey)).toBe(true);

    await archiveEvent(await db('events').where({ id }).first());

    const row = await db('events').where({ id }).first();
    expect(await zipEntryNames(row.archive_path)).toEqual([
      'individual/photo-0.jpg',
      'individual/photo-1.jpg',
      'individual/photo-2.jpg',
      'photos_manifest.json',
    ]);
    expect(await storage.exists(cacheKey)).toBe(false);
  });

  it('does not offer a prepared download whose zip the archive removed', async () => {
    const slug = 'job-gallery';
    const id = await makeEvent(slug, 2);
    const downloadJobService = require('../../src/services/downloadJobService');
    const token = 'a'.repeat(64);
    const zipPath = downloadJobService.jobKey(slug, token);
    await storage.put(zipPath, Buffer.from('prepared download'), { contentType: 'application/zip' });
    await db('download_jobs').insert({
      token,
      event_id: id,
      resolution: 'web',
      photo_ids: '[]',
      dedup_key: 'job-gallery-dedup',
      visibility_scope: 'public',
      status: 'ready',
      zip_path: zipPath,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 36e5).toISOString(),
    });

    await archiveEvent(await db('events').where({ id }).first());
    const res = await request(app).post(`/admin/archives/${id}/restore`).send({});
    expect(res.status).toBe(200);

    expect(await storage.exists(zipPath)).toBe(false);
    expect(await downloadJobService.findReusable(id, 'job-gallery-dedup')).toBeNull();
  });

  it('writes one manifest when a restored gallery is archived again', async () => {
    const slug = 'restored-gallery';
    const id = await makeEvent(slug, 2);

    await archiveEvent(await db('events').where({ id }).first());
    const res = await request(app).post(`/admin/archives/${id}/restore`).send({});
    expect(res.status).toBe(200);

    await archiveEvent(await db('events').where({ id }).first());

    const row = await db('events').where({ id }).first();
    expect(await zipEntryNames(row.archive_path)).toEqual([
      'individual/photo-0.jpg',
      'individual/photo-1.jpg',
      'photos_manifest.json',
    ]);
    expect(await storage.list(`events/active/${slug}`)).toEqual([]);
  });

  // Issue 2356: a managed replacement of an external photo outside the
  // curated selection keeps its source path through archive and restore, so
  // a rebuilt row stays out of the selection.
  it('round-trips the source path and selection flag of a managed replacement', async () => {
    const slug = 'selection-gallery';
    const id = await makeEvent(slug, 1);
    await db('events').where({ id }).update({ source_mode: 'reference', external_path: 'shoot', selection_path: 'gallery' });
    await db('photos').where({ event_id: id }).update({ external_relpath: 'shoot/raw/photo-0.jpg', selection_hidden: 1 });

    await archiveEvent(await db('events').where({ id }).first());
    // The row is gone (restored into a database that lost it): the archive
    // is all the restore has to rebuild it from.
    await db('photos').where({ event_id: id }).del();
    const res = await request(app).post(`/admin/archives/${id}/restore`).send({});
    expect(res.status).toBe(200);

    const photo = await db('photos').where({ event_id: id }).first();
    expect(photo.external_relpath).toBe('shoot/raw/photo-0.jpg');
    expect(Boolean(photo.selection_hidden)).toBe(true);
  });

  it('drops a RAW develop preview of a photo that has no edited render (issue 2619)', async () => {
    const id = await makeEvent('archive-raw-preview', 0);
    const key = `events/active/archive-raw-preview/individual/shot.cr3`;
    await storage.put(key, Buffer.from('raw bytes'), { contentType: 'image/x-canon-cr3' });
    const photoId = unwrap(await db('photos').insert({
      event_id: id, filename: 'shot.cr3', path: key, type: 'individual', size_bytes: 9,
      source_origin: 'managed', mime_type: 'image/x-canon-cr3', uploaded_at: new Date().toISOString(),
    }).returning('id'));
    // Opening the editor on a RAW caches its develop preview; nothing was saved.
    const previewKey = require('../../src/services/rawDevelop').previewKey(await db('photos').where({ id: photoId }).first());
    await storage.put(previewKey, Buffer.from('PPDV preview'));
    await archiveEvent(await db('events').where({ id }).first());
    expect(await storage.stat(previewKey)).toBeFalsy();
  });
});

