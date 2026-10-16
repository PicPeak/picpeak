/**
 * Maximum protection caps the full-size view (issue 2152).
 *
 * At protection level maximum, GET /:slug/photo/:id answers a copy that fits
 * inside 1920x1080, re-encoded at quality 60, rather than the stored
 * original, as the secure route removed in PR 1669 did. Videos still stream
 * with Range, standard and enhanced still get the source bytes, a watermark
 * still lands on the capped copy, the copy carries no EXIF, and the ETag and
 * the list URL differ from the uncapped answer so no cache hands one out for
 * the other.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const exifr = require('exifr');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'maximum-cap-test-secret';

const WATERMARK = { enabled: true, logoPath: null, position: 'center', opacity: 80, size: 40, companyName: 'Cap Studio' };
const VIDEO_BYTES = Buffer.from('not really an mp4, but the route only streams bytes');

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('maximum protection caps the full-size view (issue 2152)', () => {
  let db;
  let cleanup;
  let app;
  let source;
  let watermarkService;
  let slugCounter = 0;

  const galleryToken = (event) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'client' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent(level) {
    slugCounter += 1;
    const slug = `max-cap-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Maximum Cap ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `max-cap-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      protection_level: level,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'photo.jpg'), source);
    await fs.promises.writeFile(path.join(dir, 'clip.mp4'), VIDEO_BYTES);
    const photo = await db('photos').insert({
      event_id: id,
      filename: 'photo.jpg',
      path: `${slug}/photo.jpg`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      size_bytes: source.length,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    const video = await db('photos').insert({
      event_id: id,
      filename: 'clip.mp4',
      path: `${slug}/clip.mp4`,
      type: 'individual',
      media_type: 'video',
      mime_type: 'video/mp4',
      size_bytes: VIDEO_BYTES.length,
      uploaded_at: new Date(Date.now() - 1000).toISOString(),
    }).returning('id');
    const event = await db('events').where({ id }).first();
    return { event, photoId: photo[0]?.id ?? photo[0], videoId: video[0]?.id ?? video[0], token: galleryToken(event) };
  }

  const get = (g, url) => request(app).get(url).set('Authorization', `Bearer ${g.token}`);
  const fetchPhoto = (g) => get(g, `/api/gallery/${g.event.slug}/photo/${g.photoId}`).buffer(true).parse(binary);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    watermarkService = require('../../src/services/watermarkService');

    // 3000x2000 of noise tagged orientation 6 (shown as 2000x3000) with a
    // GPS position: big enough that a quality-60 copy inside 1920x1080 is
    // smaller, and carrying what the capped copy must drop.
    const width = 3000;
    const height = 2000;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) >>> 24;
    source = await sharp(raw, { raw: { width, height, channels: 3 } })
      .withExif({
        IFD0: { Artist: 'Cap Tester' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 8/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '11/1 34/1 0/1' },
      })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
  });

  let drawn;
  beforeEach(() => {
    drawn = [];
    const real = watermarkService.applyWatermark.bind(watermarkService);
    jest.spyOn(watermarkService, 'applyWatermark').mockImplementation((input, settings, opts) => {
      drawn.push(settings);
      return real(input, settings, opts);
    });
    jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue({ ...WATERMARK, enabled: false });
    watermarkService.clearCache();
  });
  afterEach(() => jest.restoreAllMocks());

  test('the source carries orientation and GPS EXIF (fixture check)', async () => {
    const meta = await sharp(source).metadata();
    expect(meta.orientation).toBe(6);
    const exif = await exifr.parse(source, { gps: true });
    expect(exif).toMatchObject({ Artist: 'Cap Tester' });
    expect(exif.latitude).toBeCloseTo(48.133, 2);
  });

  test('at maximum, the photo route answers a JPEG inside 1920x1080, smaller than the source', async () => {
    const g = await makeEvent('maximum');
    const res = await fetchPhoto(g).expect(200);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(res.body.length).toBeLessThan(source.length);
    const meta = await sharp(res.body).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1080);
    // Rotated: the photo is shown portrait, so the cap is height-bound.
    expect(meta.height).toBe(1080);
    expect(meta.width).toBe(720);
  });

  test('the capped copy carries no EXIF (no GPS) and no orientation tag', async () => {
    const g = await makeEvent('maximum');
    const res = await fetchPhoto(g).expect(200);
    const meta = await sharp(res.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
    expect(await exifr.parse(res.body, { gps: true })).toBeUndefined();
  });

  test.each(['standard', 'enhanced'])('at %s, the photo route still answers the source bytes', async (level) => {
    const g = await makeEvent(level);
    const res = await fetchPhoto(g).expect(200);
    expect(res.body.equals(source)).toBe(true);
  });

  test('a video at maximum streams unchanged, and Range still works', async () => {
    const g = await makeEvent('maximum');
    const whole = await get(g, `/api/gallery/${g.event.slug}/photo/${g.videoId}`).buffer(true).parse(binary).expect(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.body.equals(VIDEO_BYTES)).toBe(true);
    const part = await get(g, `/api/gallery/${g.event.slug}/photo/${g.videoId}`).set('Range', 'bytes=0-9').expect(206);
    expect(part.headers['content-range']).toBe(`bytes 0-9/${VIDEO_BYTES.length}`);
  });

  test('a watermarked gallery at maximum still gets the mark on the capped copy', async () => {
    const g = await makeEvent('maximum');
    const plain = await fetchPhoto(g).expect(200);
    expect(drawn).toHaveLength(0);

    watermarkService.getWatermarkSettings.mockResolvedValue({ ...WATERMARK });
    const marked = await fetchPhoto(g).expect(200);
    expect(drawn.length).toBeGreaterThanOrEqual(1);
    expect(drawn.at(-1)).toMatchObject({ enabled: true });
    expect(marked.headers.etag).not.toBe(plain.headers.etag);
    const meta = await sharp(marked.body).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1080);
    expect(marked.body.equals(plain.body)).toBe(false);
  });

  test('the ETag and the list URL differ between maximum and standard', async () => {
    const g = await makeEvent('standard');
    const standard = await fetchPhoto(g).expect(200);
    const standardList = await get(g, `/api/gallery/${g.event.slug}/photos`).expect(200);
    const standardUrl = standardList.body.photos.find((p) => p.id === g.photoId).url;

    await db('events').where({ id: g.event.id }).update({ protection_level: 'maximum' });
    const capped = await fetchPhoto(g).set('If-None-Match', standard.headers.etag).expect(200);
    expect(capped.headers.etag).toBeDefined();
    expect(capped.headers.etag).not.toBe(standard.headers.etag);

    const cappedList = await get(g, `/api/gallery/${g.event.slug}/photos`).expect(200);
    const cappedUrl = cappedList.body.photos.find((p) => p.id === g.photoId).url;
    expect(cappedUrl).not.toBe(standardUrl);
    expect(cappedUrl.startsWith(`/api/gallery/${g.event.slug}/photo/${g.photoId}`)).toBe(true);
    // Videos are not capped, so their URL does not change.
    expect(cappedList.body.photos.find((p) => p.id === g.videoId).url)
      .toBe(standardList.body.photos.find((p) => p.id === g.videoId).url);

    // And back: the capped ETag does not revalidate the original.
    await db('events').where({ id: g.event.id }).update({ protection_level: 'standard' });
    const again = await fetchPhoto(g).set('If-None-Match', capped.headers.etag).expect(200);
    expect(again.body.equals(source)).toBe(true);
  });

  // The lightbox loads the preview tier when it is enabled (and a withheld
  // original or the slideshow always do), so the cap has to hold there too.
  test('at maximum, the preview route is capped too, with its own ETag and URL', async () => {
    const g = await makeEvent('standard');
    const fetchPreview = () => get(g, `/api/gallery/${g.event.slug}/preview/${g.photoId}`).buffer(true).parse(binary);
    const uncapped = await fetchPreview().expect(200);
    const uncappedMeta = await sharp(uncapped.body).metadata();
    expect(uncappedMeta.height).toBeGreaterThan(1080);
    const standardList = await get(g, `/api/gallery/${g.event.slug}/photos`).expect(200);
    const standardPhoto = standardList.body.photos.find((p) => p.id === g.photoId);

    await db('events').where({ id: g.event.id }).update({ protection_level: 'maximum' });
    const capped = await fetchPreview().set('If-None-Match', uncapped.headers.etag).expect(200);
    expect(capped.headers.etag).not.toBe(uncapped.headers.etag);
    const meta = await sharp(capped.body).metadata();
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1080);
    expect(capped.body.length).toBeLessThan(uncapped.body.length);

    const cappedList = await get(g, `/api/gallery/${g.event.slug}/photos`).expect(200);
    const cappedPhoto = cappedList.body.photos.find((p) => p.id === g.photoId);
    expect(cappedPhoto.slideshow_url).not.toBe(standardPhoto.slideshow_url);
    expect(cappedPhoto.slideshow_url).toContain('cap=');
  });

  test('a busy image worker on the capped preview answers 503, not a fallback', async () => {
    const g = await makeEvent('maximum');
    const { refusal } = require('../../src/services/imageResourcePolicy');
    watermarkService.getWatermarkSettings.mockResolvedValue({ ...WATERMARK });
    watermarkService.applyWatermark.mockRejectedValue(
      refusal('Image processing is busy; try again shortly', 'IMAGE_QUEUE_FULL', { retryAfter: 5 })
    );
    const res = await get(g, `/api/gallery/${g.event.slug}/preview/${g.photoId}`).expect(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['cache-control']).toBe('no-store');
    // Not the image's ETag (Express may add a weak one for the JSON body).
    expect(res.headers.etag || '').not.toMatch(/preview-/);
    expect(res.body).toMatchObject({ code: 'IMAGE_QUEUE_FULL' });
  });

  test('an animated preview keeps its frames when capped', async () => {
    const g = await makeEvent('maximum');
    const frame = (r) => sharp({ create: { width: 2400, height: 1600, channels: 4, background: { r, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const frames = await Promise.all([frame(255), frame(0)]);
    const animated = await sharp(frames, { join: { animated: true } }).webp({ loop: 0 }).toBuffer();
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', g.event.slug);
    await fs.promises.writeFile(path.join(dir, 'anim.webp'), animated);
    const inserted = await db('photos').insert({
      event_id: g.event.id,
      filename: 'anim.webp',
      path: `${g.event.slug}/anim.webp`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/webp',
      size_bytes: animated.length,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];

    const res = await get(g, `/api/gallery/${g.event.slug}/photo/${id}`).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toMatch(/^image\/webp/);
    const meta = await sharp(res.body, { animated: true }).metadata();
    expect(meta.pages).toBe(2);
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.pageHeight).toBeLessThanOrEqual(1080);
  });
});
