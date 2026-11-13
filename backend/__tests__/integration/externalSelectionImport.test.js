/**
 * A curated selection inside an external source (issue 2356, migration 361).
 *
 * The source is the whole project folder; events.selection_path names the
 * subfolder guests get. Each row carries selection_hidden from its path: on
 * insert, when a rename moves it, and after a selection change. A file in the
 * selection and one of the same name elsewhere are two photos. A file taken
 * out of the selection folder leaves the gallery without being reported as a
 * missing file.
 *
 * Driven through the real import pass against real files.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('curated selection inside an external source (issue 2356)', () => {
  let tmpDir; let db; let app; let mediaRoot; let importExternalFolder;

  const writeJpeg = async (rel, color = { r: 10, g: 20, b: 30 }, { exifDate = '2026:06:01 10:00:00' } = {}) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    let img = sharp({ create: { width: 24, height: 16, channels: 3, background: color } });
    if (exifDate) img = img.withExif({ IFD2: { DateTimeOriginal: exifDate } });
    await img.jpeg().toFile(full);
    // Older than any settle window an automatic pass uses.
    const old = new Date(Date.now() - 600000);
    await fs.promises.utimes(full, old, old);
    return full;
  };
  const rm = (rel) => fs.promises.rm(path.join(mediaRoot, rel), { recursive: true, force: true });

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extselection-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extselection-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      ...jest.requireActual('../../src/middleware/permissions'),
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      ...jest.requireActual('../../src/middleware/ownership'),
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return {
        ...actual,
        generateThumbnail: jest.fn(async (_src, { outputBasename }) => `thumbnails/thumb_${outputBasename}`),
        ensureThumbnail: jest.fn(),
      };
    });
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    await require('./helpers/externalMediaFixture').seedExternalAdminFixture(db);
    ({ importExternalFolder } = require('../../src/services/externalImportService'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent() {
    await db('photos').del();
    await db('external_import_exclusions').del();
    await db('events').del();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    const [e] = await db('events').insert({
      slug: `extvanished-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'extvanished', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `extvanished-${Math.random()}`, expires_at: new Date().toISOString(),
      source_mode: 'reference', created_by: 1,
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const scan = (eventId, externalPath = 'shoot', extra = {}) => importExternalFolder({
    eventId, externalPath, recursive: true, actor: { type: 'admin', id: 1 }, ...extra,
  });
  const rows = (eventId) => db('photos').where({ event_id: eventId }).orderBy('id');

  const flags = async (eventId) => Object.fromEntries((await rows(eventId))
    .map((r) => [r.external_relpath, { hidden: Boolean(r.selection_hidden), gone: r.unavailable_reason }]));
  const setSelection = (eventId, selectionPath) => request(app)
    .put(`/api/admin/events/${eventId}/selection`).send({ selection_path: selectionPath });

  it('marks the photos outside the selection folder from their first import', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/IMG_1.jpg');
    await writeJpeg('shoot/Originale/day1/IMG_1.jpg', { r: 200, g: 10, b: 10 });
    await writeJpeg('shoot/Originale/day1/IMG_2.jpg', { r: 10, g: 200, b: 10 });
    await db('events').where({ id: eventId }).update({ external_path: 'shoot', selection_path: 'gallery' });

    // The edit in the selection and the original of the same name are two photos.
    expect(await scan(eventId)).toMatchObject({ imported: 3 });
    expect(await flags(eventId)).toEqual({
      'shoot/gallery/IMG_1.jpg': { hidden: false, gone: null },
      'shoot/Originale/day1/IMG_1.jpg': { hidden: true, gone: null },
      'shoot/Originale/day1/IMG_2.jpg': { hidden: true, gone: null },
    });

    // What an ordinary guest lists, and what a full-link guest lists.
    const { applyPhotoVisibilityFilter, livePhotos } = require('../../src/utils/photoVisibility');
    const listed = async (viewer) => (await applyPhotoVisibilityFilter(livePhotos(db).where('photos.event_id', eventId), viewer)
      .select('photos.external_relpath')).map((r) => r.external_relpath).sort();
    expect(await listed('guest')).toEqual(['shoot/gallery/IMG_1.jpg']);
    expect(await listed({ accessLevel: 'guest', fullView: true })).toHaveLength(3);
    expect(await listed('client')).toHaveLength(3);
    expect(await listed({ accessLevel: 'slideshow', fullView: true })).toEqual(['shoot/gallery/IMG_1.jpg']);
  });

  it('takes a file out of the selection without reporting it missing, and back in', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/IMG_1.jpg');
    await writeJpeg('shoot/Originale/IMG_9.jpg', { r: 200, g: 10, b: 10 });
    await db('events').where({ id: eventId }).update({ external_path: 'shoot', selection_path: 'gallery' });
    await scan(eventId);

    await rm('shoot/gallery/IMG_1.jpg');
    expect(await scan(eventId)).toMatchObject({ missing: 1 });
    expect((await flags(eventId))['shoot/gallery/IMG_1.jpg'].gone).toBe('selection_removed');
    // Not in the admin's "missing files" count (adminExternalMedia status).
    const missingFiles = await db('photos').where({ event_id: eventId, unavailable_reason: 'source_missing' }).count({ n: '*' }).first();
    expect(Number(missingFiles.n)).toBe(0);

    await writeJpeg('shoot/gallery/IMG_1.jpg');
    expect(await scan(eventId)).toMatchObject({ returned: 1 });
    expect((await flags(eventId))['shoot/gallery/IMG_1.jpg'].gone).toBeNull();
  });

  it('re-marks every photo when the admin changes the selection folder', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/a.jpg');
    await writeJpeg('shoot/best/b.jpg', { r: 200, g: 10, b: 10 });
    await db('events').where({ id: eventId }).update({ external_path: 'shoot' });
    await scan(eventId);
    expect(Object.values(await flags(eventId)).every((f) => !f.hidden)).toBe(true);

    let res = await setSelection(eventId, 'best');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ selection_path: 'best', in_selection: 1, outside_selection: 1 });
    expect((await flags(eventId))['shoot/gallery/a.jpg'].hidden).toBe(true);

    res = await setSelection(eventId, '');
    expect(res.body).toMatchObject({ selection_path: null, in_selection: 2, outside_selection: 0 });
  });

  it('refuses a selection folder that is not in the source', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/a.jpg');
    await db('events').where({ id: eventId }).update({ external_path: 'shoot' });
    for (const value of ['missing', '../elsewhere', 'gallery/../..']) {
      const res = await setSelection(eventId, value);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SELECTION_PATH');
    }
    await db('events').where({ id: eventId }).update({ source_mode: 'managed' });
    expect((await setSelection(eventId, 'gallery')).status).toBe(400);
  });

  it('moves a renamed file across the selection boundary with its flag', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/a.jpg');
    await db('events').where({ id: eventId }).update({ external_path: 'shoot', selection_path: 'gallery' });
    await scan(eventId);
    const before = await rows(eventId);
    await fs.promises.mkdir(path.join(mediaRoot, 'shoot/rest'), { recursive: true });
    await fs.promises.rename(path.join(mediaRoot, 'shoot/gallery/a.jpg'), path.join(mediaRoot, 'shoot/rest/a.jpg'));
    await writeJpeg('shoot/gallery/keep.jpg', { r: 1, g: 2, b: 3 });
    expect(await scan(eventId)).toMatchObject({ moved: 1 });
    const moved = await db('photos').where({ id: before[0].id }).first();
    expect(moved.external_relpath).toBe('shoot/rest/a.jpg');
    expect(Boolean(moved.selection_hidden)).toBe(true);
  });

  it('matches the selection folder literally, wildcards in names included', async () => {
    const eventId = await seedEvent();
    await db('events').where({ id: eventId }).update({ external_path: 'a_b', selection_path: 'g%' });
    const insert = (rel) => db('photos').insert({
      event_id: eventId, filename: path.basename(rel), path: rel, type: 'individual',
      source_origin: 'external', external_relpath: rel, uploaded_at: new Date().toISOString(),
    });
    await insert('a_b/g%/in.jpg');
    // Would match an unescaped LIKE 'a_b/g%/%'.
    await insert('axb/gzz/out.jpg');
    await insert('a_b/g%x/out2.jpg');
    await require('../../src/services/externalSelection').recomputeSelection(eventId);
    expect(await flags(eventId)).toEqual({
      'a_b/g%/in.jpg': { hidden: false, gone: null },
      'axb/gzz/out.jpg': { hidden: true, gone: null },
      'a_b/g%x/out2.jpg': { hidden: true, gone: null },
    });
  });

  it('compares the selection folder case-sensitively, like the importer', async () => {
    const eventId = await seedEvent();
    // SQLite's LIKE ignores ASCII case: "Gallery" would have counted as inside
    // "gallery" here while the importer hides it. Non-ASCII names count by
    // character on both engines.
    await db('events').where({ id: eventId }).update({ external_path: 'shoot', selection_path: 'Ölbild' });
    const insert = (rel, hidden) => db('photos').insert({
      event_id: eventId, filename: path.basename(rel), path: rel, type: 'individual',
      source_origin: 'external', external_relpath: rel, uploaded_at: new Date().toISOString(),
      selection_hidden: hidden,
    });
    await insert('shoot/Ölbild/in.jpg', true);
    await insert('shoot/ölbild/out.jpg', false);
    await insert('shoot/ÖLBILD/out2.jpg', false);
    await require('../../src/services/externalSelection').recomputeSelection(eventId);
    expect(await flags(eventId)).toEqual({
      'shoot/Ölbild/in.jpg': { hidden: false, gone: null },
      'shoot/ölbild/out.jpg': { hidden: true, gone: null },
      'shoot/ÖLBILD/out2.jpg': { hidden: true, gone: null },
    });
    await db('events').where({ id: eventId }).update({ selection_path: 'gallery' });
    await db('photos').where({ event_id: eventId }).del();
    await insert('shoot/Gallery/x.jpg', true);
    await require('../../src/services/externalSelection').recomputeSelection(eventId);
    expect((await flags(eventId))['shoot/Gallery/x.jpg'].hidden).toBe(true);
  });

  it('keys the selection by the folder an import rebinds the event to', async () => {
    const eventId = await seedEvent();
    await writeJpeg('first/gallery/a.jpg');
    await writeJpeg('second/gallery/IMG_1.jpg');
    await writeJpeg('second/Originale/IMG_1.jpg', { r: 200, g: 10, b: 10 });
    await db('events').where({ id: eventId }).update({ external_path: 'first', selection_path: 'gallery' });
    await scan(eventId, 'first');
    await db('photos').where({ event_id: eventId }).del();

    // Keyed by the old binding, both IMG_1.jpg looked like non-selection
    // files of one name and only one was imported.
    expect(await scan(eventId, 'second')).toMatchObject({ imported: 2 });
    expect(await flags(eventId)).toEqual({
      'second/gallery/IMG_1.jpg': { hidden: false, gone: null },
      'second/Originale/IMG_1.jpg': { hidden: true, gone: null },
    });
  });

  it('leaves the flags of the selection saved last when changes overlap, and drops the prebuilt archive', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/a.jpg');
    await writeJpeg('shoot/best/b.jpg', { r: 200, g: 10, b: 10 });
    await db('events').where({ id: eventId }).update({ external_path: 'shoot' });
    await scan(eventId);
    const zip = require('../../src/services/downloadZipService');
    const invalidate = jest.spyOn(zip, 'invalidate').mockImplementation(() => {});
    try {
      await Promise.all([setSelection(eventId, 'best'), setSelection(eventId, 'gallery'), setSelection(eventId, 'best')]);
      const { selection_path: saved } = await db('events').where({ id: eventId }).first('selection_path');
      const f = await flags(eventId);
      expect(f['shoot/gallery/a.jpg'].hidden).toBe(saved !== 'gallery');
      expect(f['shoot/best/b.jpg'].hidden).toBe(saved !== 'best');
      expect(invalidate).toHaveBeenCalledWith(eventId);
    } finally {
      invalidate.mockRestore();
    }
  });

  it('puts every photo back in the selection when the source is detached', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/a.jpg');
    await writeJpeg('shoot/best/b.jpg', { r: 200, g: 10, b: 10 });
    await db('events').where({ id: eventId }).update({ external_path: 'shoot', selection_path: 'gallery' });
    await scan(eventId);
    expect((await flags(eventId))['shoot/best/b.jpg'].hidden).toBe(true);

    const res = await request(app).put(`/api/admin/events/${eventId}`).send({ source_mode: 'managed' });
    expect(res.status).toBe(200);
    expect((await db('events').where({ id: eventId }).first()).selection_path).toBeNull();
    expect(Object.values(await flags(eventId)).every((f) => !f.hidden)).toBe(true);
  });

  it('manages the full link: needs a selection, rotates, removes', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/gallery/a.jpg');
    await db('events').where({ id: eventId }).update({ external_path: 'shoot' });
    expect((await request(app).post(`/api/admin/events/${eventId}/selection/full-link`)).body.code).toBe('SELECTION_REQUIRED');
    await setSelection(eventId, 'gallery');
    const first = await request(app).post(`/api/admin/events/${eventId}/selection/full-link`);
    expect(first.status).toBe(200);
    expect(first.body.full_link_url).toMatch(/\/gallery\/[^/]+\/full\/[0-9a-f]{64}$/);
    const second = await request(app).post(`/api/admin/events/${eventId}/selection/full-link`);
    expect(second.body.full_link_url).not.toBe(first.body.full_link_url);
    const removed = await request(app).delete(`/api/admin/events/${eventId}/selection/full-link`);
    expect(removed.body.full_link_url).toBeNull();
    expect((await db('events').where({ id: eventId }).first()).full_share_token).toBeNull();
  });
});
