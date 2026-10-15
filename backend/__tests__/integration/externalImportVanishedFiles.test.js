/**
 * Files removed or renamed on an external share (issue 2121).
 *
 * A re-scan imported new files and refreshed changed ones, but a file that
 * disappeared left its row in the gallery, and a renamed file came in as a
 * second photo next to the old row. A scan never deletes: after a complete
 * walk of a folder that answered, a served row whose file is gone is marked
 * unavailable (out of every gallery view, kept for the admin), the mark goes
 * when the file returns, and a rename moves the row to the new path.
 *
 * Driven through the real import pass against real files.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('external re-scan of files gone from the share', () => {
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
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extvanished-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extvanished-secret';

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
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
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
  const byName = async (eventId, filename) => db('photos').where({ event_id: eventId, filename }).first();

  async function importTwo() {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    await writeJpeg('shoot/b.jpg', { r: 200, g: 10, b: 10 });
    expect(await scan(eventId)).toMatchObject({ imported: 2, missing: 0 });
    return eventId;
  }

  it('hides a photo whose file was deleted, without deleting the row', async () => {
    const eventId = await importTwo();
    const zips = jest.spyOn(require('../../src/services/downloadZipService'), 'invalidate');
    await rm('shoot/a.jpg');

    expect(await scan(eventId)).toMatchObject({ imported: 0, missing: 1, returned: 0 });

    const all = await rows(eventId);
    expect(all).toHaveLength(2);
    const a = await byName(eventId, 'a.jpg');
    expect(a.unavailable_reason).toBe('source_missing');
    expect(a.deleted_at).toBeNull();
    // The admin's visibility is not the mechanism.
    expect(a.visibility === 'hidden').toBe(false);
    expect((await byName(eventId, 'b.jpg')).unavailable_reason).toBeNull();
    expect(zips).toHaveBeenCalledWith(eventId);
    zips.mockRestore();

    // Out of what the gallery shows any viewer.
    const { wherePhotoProcessed, livePhotos } = require('../../src/utils/photoVisibility');
    const listed = await wherePhotoProcessed(livePhotos(db).where('photos.event_id', eventId)).select('photos.filename');
    expect(listed.map((r) => r.filename)).toEqual(['b.jpg']);

    // A second pass over the same state changes nothing.
    expect(await scan(eventId)).toMatchObject({ missing: 0, returned: 0 });
  });

  it('shows the photo again when its file comes back', async () => {
    const eventId = await importTwo();
    await rm('shoot/a.jpg');
    await scan(eventId);
    await writeJpeg('shoot/a.jpg');

    expect(await scan(eventId)).toMatchObject({ imported: 0, returned: 1, missing: 0 });
    expect(await rows(eventId)).toHaveLength(2);
    expect((await byName(eventId, 'a.jpg')).unavailable_reason).toBeNull();
  });

  it('keeps the photo out while its returning file is still being copied', async () => {
    const eventId = await importTwo();
    await db('events').where({ id: eventId }).update({
      external_path: 'shoot', external_watch: 1, is_active: 1, is_archived: 0,
    });
    const a = await byName(eventId, 'a.jpg');
    await rm('shoot/a.jpg');
    await scan(eventId);
    expect((await db('photos').where({ id: a.id }).first()).unavailable_reason).toBe('source_missing');

    // Back with other bytes, written just now: inside the settle window.
    const full = await writeJpeg('shoot/a.jpg', { r: 250, g: 250, b: 0 });
    await fs.promises.utimes(full, new Date(), new Date());
    const pass = { eventId, externalPath: 'shoot', actor: { type: 'system' }, automatic: true, settleMs: 5000 };
    expect(await importExternalFolder(pass)).toMatchObject({ deferred: 1, returned: 0 });
    expect((await db('photos').where({ id: a.id }).first()).unavailable_reason).toBe('source_missing');

    // Settled: refreshed and back.
    const old = new Date(Date.now() - 60000);
    await fs.promises.utimes(full, old, old);
    expect(await importExternalFolder(pass)).toMatchObject({ refreshed: 1, returned: 1 });
    expect((await db('photos').where({ id: a.id }).first()).unavailable_reason).toBeNull();
  });

  it('keeps the photo out while its returning file cannot be read', async () => {
    const eventId = await importTwo();
    const a = await byName(eventId, 'a.jpg');
    await rm('shoot/a.jpg');
    await scan(eventId);
    await fs.promises.writeFile(path.join(mediaRoot, 'shoot', 'a.jpg'), 'not a jpeg at all');

    expect(await scan(eventId)).toMatchObject({ refreshed: 0, returned: 0 });
    expect((await db('photos').where({ id: a.id }).first()).unavailable_reason).toBe('source_missing');

    await writeJpeg('shoot/a.jpg', { r: 1, g: 2, b: 3 });
    expect(await scan(eventId)).toMatchObject({ refreshed: 1, returned: 1 });
    expect((await db('photos').where({ id: a.id }).first()).unavailable_reason).toBeNull();
  });

  it('keeps the photo out when refreshing its returning file fails', async () => {
    const eventId = await importTwo();
    const a = await byName(eventId, 'a.jpg');
    await rm('shoot/a.jpg');
    await scan(eventId);
    const full = await writeJpeg('shoot/a.jpg', { r: 9, g: 9, b: 9 });

    // The walk's stat answers, the refresh's does not (a NAS hiccup).
    const realStat = fs.promises.stat;
    let calls = 0;
    const stat = jest.spyOn(fs.promises, 'stat').mockImplementation(async (p, ...rest) => {
      if (p === full && ++calls === 2) throw Object.assign(new Error('I/O error'), { code: 'EIO' });
      return realStat.call(fs.promises, p, ...rest);
    });
    try {
      expect(await scan(eventId)).toMatchObject({ refreshed: 0, returned: 0 });
    } finally {
      stat.mockRestore();
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((await db('photos').where({ id: a.id }).first()).unavailable_reason).toBe('source_missing');
  });

  it('restores a returning file another file of the same name shadows', async () => {
    const eventId = await seedEvent();
    // Two folders imported one by one into a flat gallery: two a.jpg rows.
    await writeJpeg('shoot/x/a.jpg');
    await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 5, g: 90, b: 5 } } })
      .jpeg().toFile(path.join(mediaRoot, 'shoot', 'big.tmp'));
    await fs.promises.mkdir(path.join(mediaRoot, 'shoot', 'y'), { recursive: true });
    await fs.promises.rename(path.join(mediaRoot, 'shoot', 'big.tmp'), path.join(mediaRoot, 'shoot', 'y', 'a.jpg'));
    const old = new Date(Date.now() - 600000);
    await fs.promises.utimes(path.join(mediaRoot, 'shoot', 'y', 'a.jpg'), old, old);
    expect(await scan(eventId, 'shoot/x')).toMatchObject({ imported: 1 });
    expect(await scan(eventId, 'shoot/y')).toMatchObject({ imported: 1 });
    await writeJpeg('shoot/keep.jpg', { r: 1, g: 1, b: 1 });
    const small = await db('photos').where({ event_id: eventId, external_relpath: path.join('shoot', 'x', 'a.jpg') }).first();

    // A pass over the parent keeps the larger a.jpg only.
    const aside = path.join(tmpDir, 'small-aside.jpg');
    await fs.promises.rename(path.join(mediaRoot, 'shoot', 'x', 'a.jpg'), aside);
    await scan(eventId, 'shoot');
    expect((await db('photos').where({ id: small.id }).first()).unavailable_reason).toBe('source_missing');

    await fs.promises.rename(aside, path.join(mediaRoot, 'shoot', 'x', 'a.jpg'));
    expect(await scan(eventId, 'shoot')).toMatchObject({ returned: 1 });
    expect((await db('photos').where({ id: small.id }).first()).unavailable_reason).toBeNull();
  });

  it('keeps a photo the admin hid hidden when its file comes back', async () => {
    const eventId = await importTwo();
    const a = await byName(eventId, 'a.jpg');
    await db('photos').where({ id: a.id }).update({ visibility: 'hidden' });
    await rm('shoot/a.jpg');
    await scan(eventId);
    expect(await db('photos').where({ id: a.id }).first()).toMatchObject({ visibility: 'hidden', unavailable_reason: 'source_missing' });

    await writeJpeg('shoot/a.jpg');
    await scan(eventId);
    expect(await db('photos').where({ id: a.id }).first()).toMatchObject({ visibility: 'hidden', unavailable_reason: null });
  });

  it('marks nothing when the walk was cut short', async () => {
    const eventId = await importTwo();
    await rm('shoot/a.jpg');
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/');
    await writeJpeg(`shoot/${deep}/bottom.jpg`);

    const result = await scan(eventId);
    expect(result).toMatchObject({ truncated: true, missing: 0 });
    expect((await byName(eventId, 'a.jpg')).unavailable_reason).toBeNull();
  });

  it('marks nothing when the folder is gone or lists no file', async () => {
    const eventId = await importTwo();

    // Every file gone, folder still there: an unmounted share looks the same.
    await rm('shoot/a.jpg');
    await rm('shoot/b.jpg');
    expect(await scan(eventId)).toMatchObject({ missing: 0 });

    // The folder itself gone: the pass fails and touches nothing.
    await rm('shoot');
    await expect(scan(eventId)).rejects.toMatchObject({ code: 'ENOENT' });
    const res = await request(app)
      .post(`/api/admin/external-media/events/${eventId}/import-external`)
      .send({ external_path: 'shoot', recursive: true });
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect((await rows(eventId)).map((r) => r.unavailable_reason)).toEqual([null, null]);
  });

  it('never takes a file the walk leaves out for a deleted one', async () => {
    const eventId = await importTwo();
    // A row whose file is on the share but no longer imported by type.
    await fs.promises.writeFile(path.join(mediaRoot, 'shoot', 'notes.xyz'), 'not a photo');
    await db('photos').insert({
      event_id: eventId, filename: 'notes.xyz', path: 'x/notes.xyz', type: 'individual',
      source_origin: 'external', external_relpath: path.join('shoot', 'notes.xyz'),
      uploaded_at: new Date().toISOString(),
    });

    expect(await scan(eventId)).toMatchObject({ missing: 0 });
    expect((await byName(eventId, 'notes.xyz')).unavailable_reason).toBeNull();

    // Gone, it is marked; back as the version recorded, it is restored.
    const full = path.join(mediaRoot, 'shoot', 'notes.xyz');
    const st = await fs.promises.stat(full);
    await db('photos').where({ event_id: eventId, filename: 'notes.xyz' })
      .update({ size_bytes: st.size, source_mtime_ms: Math.floor(st.mtimeMs) });
    const aside = path.join(tmpDir, 'notes-aside.xyz');
    await fs.promises.rename(full, aside);
    expect(await scan(eventId)).toMatchObject({ missing: 1 });
    await fs.promises.rename(aside, full);
    expect(await scan(eventId)).toMatchObject({ returned: 1 });
    expect((await byName(eventId, 'notes.xyz')).unavailable_reason).toBeNull();
  });

  it('leaves rows outside the folder walked, and replaced photos, alone', async () => {
    const eventId = await importTwo();
    await writeJpeg('other/c.jpg');
    expect(await scan(eventId, 'other')).toMatchObject({ imported: 1 });
    // A photo replaced by an upload keeps its relpath but is managed now.
    const b = await byName(eventId, 'b.jpg');
    await db('photos').where({ id: b.id }).update({ source_origin: 'managed' });
    await rm('shoot/a.jpg');
    await rm('shoot/b.jpg');
    await writeJpeg('shoot/keep.jpg');

    // A pass over `other` does not judge `shoot`.
    expect(await scan(eventId, 'other')).toMatchObject({ missing: 0 });
    expect((await byName(eventId, 'a.jpg')).unavailable_reason).toBeNull();

    // A pass over `shoot` marks the served row only.
    expect(await scan(eventId, 'shoot')).toMatchObject({ missing: 1 });
    expect((await byName(eventId, 'a.jpg')).unavailable_reason).toBe('source_missing');
    expect((await byName(eventId, 'b.jpg')).unavailable_reason).toBeNull();
    expect((await byName(eventId, 'c.jpg')).unavailable_reason).toBeNull();
  });

  it('marks on the automatic pass too, and leaves trashed rows alone', async () => {
    const eventId = await importTwo();
    await db('events').where({ id: eventId }).update({
      external_path: 'shoot', external_watch: 1, is_active: 1, is_archived: 0,
    });
    const b = await byName(eventId, 'b.jpg');
    await db('photos').where({ id: b.id }).update({ deleted_at: new Date().toISOString() });
    await rm('shoot/a.jpg');
    await rm('shoot/b.jpg');
    await writeJpeg('shoot/keep.jpg');

    const result = await importExternalFolder({
      eventId, externalPath: 'shoot', actor: { type: 'system' }, automatic: true, settleMs: 1000,
    });
    expect(result).toMatchObject({ missing: 1 });
    expect((await byName(eventId, 'a.jpg')).unavailable_reason).toBe('source_missing');
    expect((await db('photos').where({ id: b.id }).first()).unavailable_reason).toBeNull();
  });

  it('moves the row to a renamed file instead of importing a duplicate', async () => {
    const eventId = await importTwo();
    const a = await byName(eventId, 'a.jpg');
    await fs.promises.mkdir(path.join(mediaRoot, 'shoot', 'picked'), { recursive: true });
    await fs.promises.rename(path.join(mediaRoot, 'shoot', 'a.jpg'), path.join(mediaRoot, 'shoot', 'picked', 'a-final.jpg'));

    expect(await scan(eventId)).toMatchObject({ imported: 0, moved: 1, missing: 0 });

    const all = await rows(eventId);
    expect(all).toHaveLength(2);
    const moved = await db('photos').where({ id: a.id }).first();
    expect(moved).toMatchObject({
      external_relpath: path.join('shoot', 'picked', 'a-final.jpg'),
      filename: 'a-final.jpg',
      unavailable_reason: null,
      thumbnail_path: a.thumbnail_path,
    });
    // Nothing left to do on the next pass.
    expect(await scan(eventId)).toMatchObject({ imported: 0, moved: 0, missing: 0, refreshed: 0 });
  });

  it('does not hand a photo\'s row to another picture of the same size and time', async () => {
    const eventId = await importTwo();
    const a = await byName(eventId, 'a.jpg');
    const st = await fs.promises.stat(path.join(mediaRoot, 'shoot', 'a.jpg'));
    await rm('shoot/a.jpg');
    // Another picture, padded to the same byte count and given the same time.
    const other = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 250 } } }).jpeg().toBuffer();
    expect(other.length).toBeLessThanOrEqual(st.size);
    const full = path.join(mediaRoot, 'shoot', 'other.jpg');
    await fs.promises.writeFile(full, Buffer.concat([other, Buffer.alloc(st.size - other.length)]));
    await fs.promises.utimes(full, st.atime, st.mtime);

    expect(await scan(eventId)).toMatchObject({ moved: 0, imported: 1, missing: 1 });
    expect(await db('photos').where({ id: a.id }).first()).toMatchObject({
      external_relpath: path.join('shoot', 'a.jpg'), unavailable_reason: 'source_missing',
    });
  });

  it('does not take two pictures without a capture date for one', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg', undefined, { exifDate: null });
    await scan(eventId);
    const a = await byName(eventId, 'a.jpg');
    await fs.promises.rename(path.join(mediaRoot, 'shoot', 'a.jpg'), path.join(mediaRoot, 'shoot', 'b.jpg'));

    expect(await scan(eventId)).toMatchObject({ moved: 0, imported: 1, missing: 1 });
    expect((await db('photos').where({ id: a.id }).first()).external_relpath).toBe(path.join('shoot', 'a.jpg'));
  });

  it('moves a row already marked missing when its file turns up renamed', async () => {
    const eventId = await importTwo();
    const a = await byName(eventId, 'a.jpg');
    const tmp = path.join(tmpDir, 'a-aside.jpg');
    await fs.promises.rename(path.join(mediaRoot, 'shoot', 'a.jpg'), tmp);
    await scan(eventId);
    expect((await db('photos').where({ id: a.id }).first()).unavailable_reason).toBe('source_missing');

    await fs.promises.rename(tmp, path.join(mediaRoot, 'shoot', 'a-renamed.jpg'));
    expect(await scan(eventId)).toMatchObject({ imported: 0, moved: 1 });
    expect(await db('photos').where({ id: a.id }).first()).toMatchObject({
      external_relpath: path.join('shoot', 'a-renamed.jpg'), unavailable_reason: null,
    });
    expect(await rows(eventId)).toHaveLength(2);
  });

  it('imports and marks, instead of guessing, when a rename is ambiguous', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    await fs.promises.copyFile(path.join(mediaRoot, 'shoot/a.jpg'), path.join(mediaRoot, 'shoot/a2.jpg'));
    const st = await fs.promises.stat(path.join(mediaRoot, 'shoot/a.jpg'));
    await fs.promises.utimes(path.join(mediaRoot, 'shoot/a2.jpg'), st.atime, st.mtime);
    await writeJpeg('shoot/b.jpg', { r: 200, g: 10, b: 10 });
    await scan(eventId);

    // Two rows of the same size and time gone, one new file of that shape.
    await fs.promises.rename(path.join(mediaRoot, 'shoot/a.jpg'), path.join(mediaRoot, 'shoot/x.jpg'));
    await rm('shoot/a2.jpg');

    expect(await scan(eventId)).toMatchObject({ moved: 0, imported: 1, missing: 2 });
  });

  it('reports the missing photos on the status route', async () => {
    const eventId = await importTwo();
    await rm('shoot/a.jpg');
    await scan(eventId);
    const res = await request(app).get(`/api/admin/external-media/events/${eventId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.missing_files).toBe(1);
  });
});
