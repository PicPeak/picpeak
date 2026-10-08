/** Actual gallery routes, SQLite, native Sharp and the selected storage adapter. */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.SKIP_S3_TESTS = 'true';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-original-policy-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'original-policy-secret-at-least-thirty-two';
process.env.EXTERNAL_MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-original-policy-nas-'));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const unwrap = (rows) => rows[0]?.id ?? rows[0];
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const SLUG = 'original-policy';
const VIDEO = Buffer.from('source-video-bytes-not-a-transcoded-preview');

describe('gallery original-asset authority', () => {
  let db; let cleanup; let app; let eventId; let categoryId; let imageId; let brokenId; let videoId; let externalId;
  let source; let storage;
  const token = (claims = {}) => jwt.sign({ type: 'gallery', eventId, eventSlug: SLUG, ...claims }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
  const get = (route, id = imageId, headers = {}) => request(app).get(`/api/gallery/${SLUG}/${route}/${id}`)
    .set({ Authorization: `Bearer ${token()}`, ...headers }).buffer().parse(binary);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    eventId = unwrap(await db('events').insert({
      slug: SLUG, event_name: SLUG, event_type: 'wedding', event_date: '2026-10-08',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`, share_token: 'original-policy-share',
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0, allow_downloads: 1,
      protection_level: 'basic', expires_at: new Date(Date.now() + 864e5).toISOString(),
    }).returning('id'));
    categoryId = unwrap(await db('photo_categories').insert({ name: 'Private download', slug: 'private-download',
      event_id: eventId, is_global: 0, allow_downloads: 1 }).returning('id'));
    if (process.env.POLICY_TEST_S3_ENDPOINT) {
      Object.assign(process.env, { STORAGE_BACKEND: 's3', STORAGE_S3_ENDPOINT: process.env.POLICY_TEST_S3_ENDPOINT,
        STORAGE_S3_BUCKET: 'original-policy', STORAGE_S3_ACCESS_KEY: 'policy-test-key',
        STORAGE_S3_SECRET_KEY: 'policy-test-secret', STORAGE_S3_SSL: 'false', STORAGE_S3_FORCE_PATH_STYLE: 'true' });
      const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
      const client = new S3Client({ region: 'us-east-1', endpoint: process.env.POLICY_TEST_S3_ENDPOINT,
        forcePathStyle: true, credentials: { accessKeyId: 'policy-test-key', secretAccessKey: 'policy-test-secret' } });
      await client.send(new CreateBucketCommand({ Bucket: 'original-policy' }));
      client.destroy();
    }
    storage = require('../../src/services/storage').getStorage();
    source = await sharp({ create: { width: 3200, height: 2200, channels: 3, background: '#336699' } })
      .jpeg().withMetadata().toBuffer();
    const add = async (filename, bytes, over = {}) => {
      const key = `events/active/${SLUG}/individual/${filename}`;
      await storage.put(key, bytes);
      return unwrap(await db('photos').insert({ event_id: eventId, filename, path: `${SLUG}/individual/${filename}`,
        type: 'individual', mime_type: 'image/jpeg', category_id: categoryId, uploaded_at: new Date().toISOString(), ...over }).returning('id'));
    };
    imageId = await add('source.jpg', source);
    brokenId = await add('broken.jpg', Buffer.from('invalid-image-source-sentinel'));
    videoId = await add('source.mp4', VIDEO, { media_type: 'video', mime_type: 'video/mp4' });
    fs.mkdirSync(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'shoot'), { recursive: true });
    fs.writeFileSync(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'shoot', 'external.jpg'), source);
    externalId = unwrap(await db('photos').insert({ event_id: eventId, filename: 'external.jpg',
      path: 'shoot/external.jpg', external_relpath: 'shoot/external.jpg', source_origin: 'external',
      type: 'individual', mime_type: 'image/jpeg', category_id: categoryId }).returning('id'));
    await db('events').where({ id: eventId }).update({ external_path: 'shoot' });
    app = express();
    app.use(express.json());
    app.use(require('cookie-parser')());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/images', require('../../src/routes/protectedImages'));
    app.use('/api/secure-images', require('../../src/routes/secureImages'));
  }, 180000);
  beforeEach(async () => {
    await db('events').where({ id: eventId }).update({ allow_downloads: 1 });
    await db('photo_categories').where({ id: categoryId }).update({ allow_downloads: 1 });
  });
  afterAll(async () => {
    if (storage?.adapter?.s3Client) storage.adapter.s3Client.destroy();
    if (cleanup) await cleanup();
    fs.rmSync(process.env.EXTERNAL_MEDIA_ROOT, { recursive: true, force: true });
  });

  test('legitimate control retains original image/download bytes and source video ranges', async () => {
    for (const route of ['photo', 'download']) {
      const res = await get(route);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(source);
    }
    const video = await get('photo', videoId, { Range: 'bytes=0-5' });
    expect(video.status).toBe(206);
    expect(video.body).toEqual(VIDEO.subarray(0, 6));
  });
  test.each(['event', 'category'])('%s policy withholds source bytes but preserves bounded image presentation', async (dimension) => {
    await db(dimension === 'event' ? 'events' : 'photo_categories')
      .where({ id: dimension === 'event' ? eventId : categoryId }).update({ allow_downloads: 0 });
    for (const id of [imageId, externalId]) {
      const image = await get('photo', id);
      expect(image.status).toBe(302);
      expect(image.headers.location).toContain(`/preview/${id}`);
      const preview = await get('preview', id);
      expect(preview.status).toBe(200);
      expect(preview.body).not.toEqual(source);
      const metadata = await sharp(preview.body).metadata();
      expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(1920);
      expect((await get('download', id)).status).toBe(403);
    }
    // A video has no bounded image tier: it keeps playing inline, ranges
    // included, and only the download route refuses it.
    const whole = await get('photo', videoId);
    expect(whole.status).toBe(200);
    expect(whole.body).toEqual(VIDEO);
    expect(whole.headers['content-disposition']).toBe('inline');
    const ranged = await get('photo', videoId, { Range: 'bytes=0-5' });
    expect(ranged.status).toBe(206);
    expect(ranged.body).toEqual(VIDEO.subarray(0, 6));
    expect(ranged.headers['content-disposition']).toBe('inline');
    const viaPreview = await get('preview', videoId);
    expect(viaPreview.status).toBe(302);
    expect(viaPreview.headers.location).toContain(`/photo/${videoId}`);
    expect((await get('download', videoId)).status).toBe(403);
  });
  test('corrupt or throwing previews cannot redirect a restricted viewer to original', async () => {
    await db('events').where({ id: eventId }).update({ allow_downloads: 0 });
    const corrupt = await get('preview', brokenId);
    expect(corrupt.status).toBe(404);
    expect(corrupt.headers.location).toBeUndefined();
    const realStat = storage.stat.bind(storage);
    const spy = jest.spyOn(storage, 'stat').mockImplementation(async (key) => {
      if (key.startsWith('previews/')) throw new Error('preview failure');
      return realStat(key);
    });
    try {
      const failed = await get('preview');
      expect(failed.status).toBe(404);
      expect(failed.headers.location).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
  test('wrong token type is not source authority', async () => {
    expect((await get('photo', imageId, { Authorization: `Bearer ${token({ type: 'photo' })}` })).status).toBe(403);
  });
  test('restricted photo payloads advertise bounded presentation at every protection level', async () => {
    await db('photo_categories').where({ id: categoryId }).update({ allow_downloads: 0 });
    try {
      for (const level of ['basic', 'enhanced', 'maximum']) {
        await db('events').where({ id: eventId }).update({ protection_level: level });
        const payload = await request(app).get(`/api/gallery/${SLUG}/photos`).set('Authorization', `Bearer ${token()}`);
        expect(payload.status).toBe(200);
        const photo = payload.body.photos.find((item) => item.id === imageId);
        expect(photo.url).toContain(`/preview/${imageId}`);
        expect(photo.preview_url).toContain(`/preview/${imageId}`);
      }
    } finally { await db('events').where({ id: eventId }).update({ protection_level: 'basic' }); }
  });
  test('typed slideshow grants remain display-only and retain category scope', async () => {
    const link = 'd'.repeat(64);
    await db('feature_flags').where({ key: 'slideshow' }).del();
    await db('feature_flags').insert({ key: 'slideshow', value: 1 });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    await db('events').where({ id: eventId }).update({ show_share_token: link, show_category_id: categoryId });
    const session = await request(app).get(`/api/gallery/${SLUG}/show/${link}/session`);
    expect(session.status).toBe(200);
    const headers = { Authorization: `Bearer ${session.body.token}` };
    for (const route of ['photo', 'download']) expect((await get(route, imageId, headers)).status).toBe(403);
    expect((await get('preview', imageId, headers)).status).toBe(200);
    const other = unwrap(await db('photo_categories').insert({ name: 'Other', slug: 'other', event_id: eventId, is_global: 0 }).returning('id'));
    await db('photos').where({ id: imageId }).update({ category_id: other });
    try { expect((await get('preview', imageId, headers)).status).toBe(403); }
    finally { await db('photos').where({ id: imageId }).update({ category_id: categoryId }); }
  });
  test('visibility is preserved separately from original authority', async () => {
    await db('photos').where({ id: imageId }).update({ visibility: 'hidden' });
    try {
      for (const route of ['photo', 'preview', 'download']) expect((await get(route)).status).toBe(403);
      const client = await get('photo', imageId, { Authorization: `Bearer ${token({ accessLevel: 'client' })}` });
      expect(client.status).toBe(200);
      expect(client.body).toEqual(source);
    } finally { await db('photos').where({ id: imageId }).update({ visibility: 'visible' }); }
  });
  test('rendition pointers cannot relabel source bytes as presentation derivatives', async () => {
    await db('events').where({ id: eventId }).update({ allow_downloads: 0 });
    const key = `events/active/${SLUG}/individual/source.jpg`;
    await db('photos').where({ id: imageId }).update({ preview_path: key, thumbnail_path: key, hero_path: key });
    // The pointer is not followed and not left broken either: the rendition
    // is rebuilt from the source and the row gets a canonical key.
    const expectRebuilt = async () => {
      for (const [route, column, prefix, edge] of [['preview', 'preview_path', 'previews/preview_', 1920],
        ['thumbnail', 'thumbnail_path', 'thumbnails/thumb_', 1000]]) {
        const res = await get(route);
        expect(res.status).toBe(200);
        expect(res.body).not.toEqual(source);
        expect((await sharp(res.body).metadata()).width).toBeLessThanOrEqual(edge);
        expect((await db('photos').where({ id: imageId }).first(column))[column].startsWith(prefix)).toBe(true);
      }
      await db('photos').where({ id: imageId }).update({ preview_path: key, thumbnail_path: key });
    };
    try {
      await expectRebuilt();
      // A hero fallback may redirect, but following it never returns source.
      const hero = await get('hero');
      expect(hero.body).not.toEqual(source);
      expect((await get('photo')).status).toBe(302);
    } finally {
      await db('photos').where({ id: imageId }).update({ preview_path: null, thumbnail_path: null, hero_path: null });
    }
  });
  test('a failed mandatory preview watermark does not expose the unwatermarked derivative', async () => {
    await db('events').where({ id: eventId }).update({ allow_downloads: 0 });
    const watermark = require('../../src/services/watermarkService');
    const spy = jest.spyOn(watermark, 'getWatermarkSettings').mockResolvedValue({ enabled: true, companyName: undefined });
    try {
      expect((await get('preview')).status).toBe(404);
    } finally { spy.mockRestore(); }
  });
  test('working watermarked previews preserve bounded gallery presentation', async () => {
    await db('events').where({ id: eventId }).update({ allow_downloads: 0 });
    const plain = await get('preview');
    expect(plain.status).toBe(200);
    const watermark = require('../../src/services/watermarkService');
    const spy = jest.spyOn(watermark, 'getWatermarkSettings').mockResolvedValue({ enabled: true,
      companyName: 'Protected', opacity: 50, size: 15, position: 'center' });
    try {
      const marked = await get('preview');
      expect(marked.status).toBe(200);
      expect(marked.body).not.toEqual(plain.body);
      expect((await sharp(marked.body).metadata()).width).toBeLessThanOrEqual(1920);
    } finally { spy.mockRestore(); }
  });
  test('a legacy-shaped rendition pointer is rebuilt instead of answering 404', async () => {
    expect((await get('thumbnail')).status).toBe(200);
    expect((await get('preview')).status).toBe(200);
    const row = await db('photos').where({ id: imageId }).first('thumbnail_path', 'preview_path');
    await db('photos').where({ id: imageId }).update({
      thumbnail_path: `./${row.thumbnail_path}`, preview_path: row.preview_path.replace('/', '\\') });
    expect((await get('thumbnail')).status).toBe(200);
    expect((await get('preview')).status).toBe(200);
    const healed = await db('photos').where({ id: imageId }).first('thumbnail_path', 'preview_path');
    expect(healed.thumbnail_path.startsWith('thumbnails/thumb_')).toBe(true);
    expect(healed.preview_path.startsWith('previews/preview_')).toBe(true);
  });
  test('a text watermark wider than the image is fitted, not thrown', async () => {
    const watermark = require('../../src/services/watermarkService');
    const settings = { enabled: true, companyName: 'A'.repeat(40), opacity: 50, size: 15, position: 'bottom-right' };
    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    const marked = await watermark.applyWatermark(small, settings, { failClosed: true });
    expect(marked).not.toEqual(small);
    expect(await sharp(marked).metadata()).toMatchObject({ width: 300, height: 200 });
    // Narrower than the mark at the 8px font floor, and shorter than its box.
    const tiny = await sharp({ create: { width: 60, height: 20, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    const tinyMarked = await watermark.applyWatermark(tiny, settings, { failClosed: true });
    expect(tinyMarked).not.toEqual(tiny);
    const plain = await get('thumbnail');
    const spy = jest.spyOn(watermark, 'getWatermarkSettings').mockResolvedValue(settings);
    try {
      const thumb = await get('thumbnail');
      expect(thumb.status).toBe(200);
      expect(thumb.body).not.toEqual(plain.body);
    } finally { spy.mockRestore(); }
  });
  test('a failed watermark fails closed on the photo route the renditions redirect to', async () => {
    const watermark = require('../../src/services/watermarkService');
    const spy = jest.spyOn(watermark, 'getWatermarkSettings').mockResolvedValue({ enabled: true, companyName: undefined });
    try {
      const preview = await get('preview');
      expect(preview.status).toBe(302);
      expect(preview.headers.location).toContain(`/photo/${imageId}`);
      const photo = await get('photo');
      expect(photo.status).toBe(500);
      expect(photo.body).not.toEqual(source);
    } finally { spy.mockRestore(); }
  });
  test('the public OG cover reads only a thumbnail-namespace key', async () => {
    const og = express();
    og.get('/og/:slug', require('../../src/services/galleryOgService').handleGalleryOgCover);
    const key = `events/active/${SLUG}/individual/source.jpg`;
    await db('events').where({ id: eventId }).update({ og_image_share_enabled: 1, hero_photo_id: imageId });
    await db('photos').where({ id: imageId }).update({ thumbnail_path: key });
    const cover = () => request(og).get(`/og/${SLUG}`).buffer().parse(binary);
    try {
      const rebuilt = await cover();
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).not.toEqual(source);
      expect((await sharp(rebuilt.body).metadata()).width).toBeLessThanOrEqual(1000);
      // No rebuild possible: the pointer is refused, not read.
      const brokenKey = `events/active/${SLUG}/individual/broken.jpg`;
      await db('events').where({ id: eventId }).update({ hero_photo_id: brokenId });
      await db('photos').where({ id: brokenId }).update({ thumbnail_path: brokenKey });
      const getSpy = jest.spyOn(storage, 'get');
      try {
        expect((await cover()).status).toBe(404);
        expect(getSpy.mock.calls.filter(([k]) => k === brokenKey)).toHaveLength(0);
      } finally { getSpy.mockRestore(); }
    } finally {
      await db('events').where({ id: eventId }).update({ og_image_share_enabled: 0, hero_photo_id: null });
      await db('photos').whereIn('id', [imageId, brokenId]).update({ thumbnail_path: null });
    }
  });
  test('legacy view and capabilities enforce current original policy at every use', async () => {
    const headers = { Authorization: `Bearer ${token()}`, 'User-Agent': 'Mozilla/5.0 Chrome/130.0',
      Accept: 'image/*', 'Accept-Language': 'en', 'Accept-Encoding': 'gzip' };
    const signed = await request(app).post(`/api/images/${SLUG}/photo/${imageId}/generate-url`).set(headers);
    expect(signed.status).toBe(200);
    const minted = await request(app).post(`/api/secure-images/${SLUG}/generate-token`).set(headers).send({ photoId: imageId });
    expect(minted.status).toBe(200);
    const secureUrl = `/api/secure-images/${SLUG}/secure/${imageId}/${minted.body.token}`;
    // A basic secure view is byte-for-byte source, so this is an ordinary
    // control through the very same token-only sink we then restrict.
    const control = await request(app).get(secureUrl).set(headers).buffer().parse(binary);
    expect(control.status).toBe(200);
    expect(control.body).toEqual(source);
    await db('photo_categories').where({ id: categoryId }).update({ allow_downloads: 0 });
    for (const url of [signed.body.url, secureUrl, `/api/images/${SLUG}/photo/${imageId}/view`]) {
      const refused = await request(app).get(url).set(headers);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('Downloads are disabled for this category');
    }
  });
});
