/**
 * The gallery streams a video's browser-playable copy when the queue wrote
 * one (issue 1430, item 8), and the original otherwise. The download stays
 * the original either way.
 *
 * Through the real gallery router against SQLite and local storage: the
 * copy lives under videos/ in the managed backend, including for an external
 * (NAS) original.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-web-copy-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'web-copy-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-web-copy-storage-'));
process.env.EXTERNAL_MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-web-copy-nas-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'web-copy-gallery';
const ORIGINAL = Buffer.from('hevc-original-bytes-the-browser-cannot-play-at-all');
const COPY = Buffer.from('h264-copy-bytes');
const NAS_ORIGINAL = Buffer.from('quicktime-on-the-nas');
const NAS_COPY = Buffer.from('h264-copy-of-the-nas-clip');

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('gallery video playback with a web copy (issue 1430)', () => {
  let db; let cleanup; let app; let eventId; let nasEventId;
  let withCopy; let failedCopy; let gone; let nasWithCopy;

  const insertEvent = async (slug, over = {}) => {
    const ev = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-09-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/s`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0,
      created_at: new Date().toISOString(),
      ...over,
    }).returning('id');
    return ev[0]?.id ?? ev[0];
  };

  const insertVideo = async (filename, over = {}) => {
    const row = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${SLUG}/individual/${filename}`,
      type: 'individual',
      media_type: 'video',
      mime_type: 'video/mp4',
      uploaded_at: new Date().toISOString(),
      ...over,
    }).returning('id');
    return row[0]?.id ?? row[0];
  };

  const get = (id, headers = {}) => request(app).get(`/api/gallery/${SLUG}/photo/${id}`).set(headers).buffer().parse(binary);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    eventId = await insertEvent(SLUG);

    const mediaDir = path.join(process.env.STORAGE_PATH, 'events/active', SLUG, 'individual');
    fs.mkdirSync(mediaDir, { recursive: true });
    for (const name of ['with-copy.mp4', 'failed-copy.mp4', 'gone-copy.mp4']) {
      fs.writeFileSync(path.join(mediaDir, name), ORIGINAL);
    }
    const videosDir = path.join(process.env.STORAGE_PATH, 'videos');
    fs.mkdirSync(videosDir, { recursive: true });

    withCopy = await insertVideo('with-copy.mp4');
    fs.writeFileSync(path.join(videosDir, `web_${withCopy}_with-copy.mp4`), COPY);
    await db('photos').where({ id: withCopy }).update({ web_path: `videos/web_${withCopy}_with-copy.mp4`, web_status: 'complete' });

    failedCopy = await insertVideo('failed-copy.mp4', { web_status: 'failed', web_error: 'ffmpeg exited with code 1' });
    // The row points at a copy storage no longer has.
    gone = await insertVideo('gone-copy.mp4', { web_path: 'videos/web_0_gone.mp4', web_status: 'complete' });

    // An external original on the "NAS", its copy in the managed backend.
    const nasSlug = 'web-copy-nas';
    nasEventId = await insertEvent(nasSlug, { source_mode: 'reference', external_path: 'shoot' });
    fs.mkdirSync(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'shoot'), { recursive: true });
    fs.writeFileSync(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'shoot', 'Teaser.MOV'), NAS_ORIGINAL);
    const nas = await db('photos').insert({
      event_id: nasEventId,
      filename: 'Teaser.MOV',
      path: 'shoot/Teaser.MOV',
      external_relpath: 'shoot/Teaser.MOV',
      source_origin: 'external',
      type: 'individual',
      media_type: 'video',
      mime_type: 'video/quicktime',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    nasWithCopy = nas[0]?.id ?? nas[0];
    fs.writeFileSync(path.join(videosDir, `web_${nasWithCopy}_Teaser.mp4`), NAS_COPY);
    await db('photos').where({ id: nasWithCopy }).update({ web_path: `videos/web_${nasWithCopy}_Teaser.mp4`, web_status: 'complete' });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  test('streams the copy as video/mp4 with its own length', async () => {
    const res = await get(withCopy);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-length']).toBe(String(COPY.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.from(res.body)).toEqual(COPY);
  });

  test('answers Range requests against the copy, so seeking works on it', async () => {
    const res = await get(withCopy, { Range: 'bytes=0-4' });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-4/${COPY.length}`);
    expect(Buffer.from(res.body)).toEqual(COPY.subarray(0, 5));

    const past = await get(withCopy, { Range: `bytes=${COPY.length}-` });
    expect(past.status).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${COPY.length}`);
  });

  test('serves the original when the copy failed, or when the row points at a copy storage lost', async () => {
    for (const id of [failedCopy, gone]) {
      const res = await get(id);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body)).toEqual(ORIGINAL);
    }
    // A pointer at a copy storage lost is dropped on the spot (the setting is
    // off here, so `failed`: the next switch-on backfill rebuilds it). Left at
    // `complete` it would never be rebuilt.
    expect(await db('photos').where({ id: gone }).first()).toMatchObject({
      web_path: null, web_status: 'failed', web_error: 'copy missing from storage',
    });
    expect(await db('photos').where({ id: failedCopy }).first()).toMatchObject({ web_status: 'failed', web_error: 'ffmpeg exited with code 1' });
  });

  test('a storage error while checking the copy serves the original and keeps the pointer', async () => {
    // Only "the key is not there" (stat → null) means the copy is gone. A
    // backend that cannot answer must not cost the row its valid copy.
    const storage = require('../../src/services/storage').getStorage();
    const realStat = storage.stat.bind(storage);
    // The route stats the original first; only the copy's lookup fails here.
    const spy = jest.spyOn(storage, 'stat').mockImplementation(async (key) => {
      if (key.startsWith('videos/')) throw new Error('S3 unreachable');
      return realStat(key);
    });
    try {
      const res = await get(withCopy);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body)).toEqual(ORIGINAL);
      expect(await db('photos').where({ id: withCopy }).first()).toMatchObject({
        web_path: `videos/web_${withCopy}_with-copy.mp4`, web_status: 'complete',
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('serves the managed copy of an external original, and still the NAS file for download', async () => {
    const res = await request(app).get(`/api/gallery/web-copy-nas/photo/${nasWithCopy}`).buffer().parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(Buffer.from(res.body)).toEqual(NAS_COPY);

    const dl = await request(app).get(`/api/gallery/web-copy-nas/download/${nasWithCopy}`).buffer().parse(binary);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body)).toEqual(NAS_ORIGINAL);
  });

  test('the download route hands out the original, never the copy', async () => {
    const res = await request(app).get(`/api/gallery/${SLUG}/download/${withCopy}`).buffer().parse(binary);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(ORIGINAL);
  });
});
