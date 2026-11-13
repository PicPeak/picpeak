/**
 * Selfie search (issue 2355, migration 360).
 *
 * POST /api/gallery/:slug/face-search answers only while the event opted in
 * and the people feature is on for the viewer; the guest must consent, and
 * the server checks it. It matches the selfie's face signature against the
 * stored faces of the photos this viewer can see, leaves out people the
 * photographer hid and signatures from another model, keeps nothing of the
 * selfie, and allows five searches per ten minutes.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const sharp = require('sharp');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-selfie-secret';

const mockDetect = jest.fn();
jest.mock('../../src/services/faceClient', () => {
  const actual = jest.requireActual('../../src/services/faceClient');
  return { ...actual, detectFaces: (...args) => mockDetect(...args) };
});

const SLUG = 'selfie-gallery';
const MODEL = 'buffalo_l@1';
const DIM = 512;

function vec(parts) {
  const v = new Float32Array(DIM);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  return v;
}
const pack = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const face = (v, bbox = [10, 10, 100, 100]) => ({ bbox, score: 0.9, embedding: Array.from(v) });

describe('selfie search (issue 2355)', () => {
  let db; let cleanup; let app; let eventId; let adminToken; let selfie;
  const ids = {};
  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  async function setFlag(value) {
    await db('feature_flags').where({ key: 'faces' }).del();
    await db('feature_flags').insert({ key: 'faces', value });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  }

  const baseEvent = () => ({
    slug: SLUG, event_type: 'wedding', event_name: 'Selfie Gallery', event_date: '2026-08-01',
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
    require_password: 0,
    share_link: `/gallery/${SLUG}/share`, share_token: 'selfie-gallery-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, temporarily_disabled: 0, reveal_mode: 0, revealed_at: null,
    face_recognition_enabled: 1, faces_visible_to_guests: 1, face_selfie_search_enabled: 1,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    adminToken = mintAdminToken(adminId);
    await setFlag(true);

    eventId = unwrap(await db('events').insert({ ...baseEvent(), created_by: adminId, created_at: new Date().toISOString() }).returning('id'));
    const hiddenPerson = unwrap(await db('event_people').insert({ event_id: eventId, is_hidden: true, face_count_total: 1 }).returning('id'));
    const ignoredPerson = unwrap(await db('event_people').insert({ event_id: eventId, is_ignored: true, face_count_total: 1 }).returning('id'));

    // name → [photo fields, face embedding, face fields]
    const fixtures = {
      exact: [{}, vec({ 0: 1 })],
      close: [{}, vec({ 0: 0.6, 1: 0.8 })], // 0.60 with the probe: above 0.50
      far: [{}, vec({ 0: 0.4, 1: Math.sqrt(1 - 0.16) })], // 0.40: below
      stranger: [{}, vec({ 1: 1 })],
      hiddenPhoto: [{ visibility: 'hidden' }, vec({ 0: 1 })],
      hiddenPerson: [{}, vec({ 0: 1 }), { person_id: hiddenPerson }],
      ignoredPerson: [{}, vec({ 0: 1 }), { person_id: ignoredPerson }],
      otherModel: [{}, vec({ 0: 1 }), { model_version: 'other@2' }],
    };
    for (const [name, [photo, embedding, extra = {}]] of Object.entries(fixtures)) {
      ids[name] = unwrap(await db('photos').insert({
        event_id: eventId, filename: `${name}.jpg`, path: `events/${SLUG}/${name}.jpg`,
        thumbnail_path: `thumbnails/thumb_${name}.jpg`, media_type: 'image', mime_type: 'image/jpeg',
        type: 'individual', processing_status: 'complete', uploaded_at: new Date().toISOString(), ...photo,
      }).returning('id'));
      await db('photo_faces').insert({
        photo_id: ids[name], event_id: eventId, bbox_x: 0, bbox_y: 0, bbox_w: 50, bbox_h: 50,
        embedding: pack(embedding), model_version: MODEL, created_at: new Date().toISOString(), ...extra,
      });
    }

    selfie = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c08060' } }).jpeg().toBuffer();

    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    mockDetect.mockReset();
    mockDetect.mockResolvedValue({ model_version: MODEL, faces: [face(vec({ 0: 1 }))] });
  });

  afterEach(async () => {
    await db('events').where({ id: eventId }).update(baseEvent());
    await setFlag(true);
  });

  // Each test from its own address, so the rate limit test alone spends one.
  let ipCounter = 1;
  const search = ({ consent = 'true', file = selfie, ip } = {}) => {
    const req = request(app).post(`/api/gallery/${SLUG}/face-search`)
      .set('X-Forwarded-For', ip || `198.51.100.${ipCounter++}`);
    if (consent !== null) req.field('consent', consent);
    if (file) req.attach('selfie', file, { filename: 'me.jpg', contentType: 'image/jpeg' });
    return req;
  };

  it('returns the visible photos with a matching face, best first', async () => {
    const res = await search();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body).toEqual({ photo_ids: [ids.exact, ids.close] });
  });

  it('sends the sidecar a normalised JPEG, not the upload itself', async () => {
    const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#808080' } }).png().toBuffer();
    await search({ file: png });
    const [sent, name] = mockDetect.mock.calls[0];
    expect(name).toBe('selfie.jpg');
    const meta = await sharp(sent).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBe(1280);
  });

  it('keeps the JPEG for the sidecar under its 1 MiB in-memory limit', async () => {
    // Noise does not compress: at 1280 px and quality 90 this is well over
    // 1 MiB, which the sidecar's multipart parser would spool to disk.
    const noise = require('crypto').randomBytes(1280 * 1280 * 3);
    const busy = await sharp(noise, { raw: { width: 1280, height: 1280, channels: 3 } }).png().toBuffer();
    const big = await sharp(busy).jpeg({ quality: 90 }).toBuffer();
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const res = await search({ file: busy });
    expect(res.status).toBe(200);
    const [sent] = mockDetect.mock.calls[0];
    const { MAX_SIDECAR_BYTES } = require('../../src/services/faceSearch');
    expect(sent.length).toBeLessThanOrEqual(MAX_SIDECAR_BYTES);
    expect((await sharp(sent).metadata()).format).toBe('jpeg');
  });

  it('searches with the largest face of the selfie', async () => {
    mockDetect.mockResolvedValue({
      model_version: MODEL,
      faces: [face(vec({ 1: 1 }), [0, 0, 20, 20]), face(vec({ 0: 1 }), [30, 30, 200, 200])],
    });
    expect((await search()).body.photo_ids).toEqual([ids.exact, ids.close]);
  });

  it('keeps nothing of the selfie', async () => {
    const tables = ['photo_faces', 'event_people', 'photos', 'access_logs', 'activity_logs'];
    const count = async () => Promise.all(tables.map(async (t) => (await db.schema.hasTable(t)) ? Number((await db(t).count('* as n').first()).n) : 0));
    const before = await count();
    expect((await search()).status).toBe(200);
    expect(await count()).toEqual(before);
  });

  it('refuses without consent, before the sidecar sees the selfie', async () => {
    for (const consent of [null, 'false', '']) {
      const res = await search({ consent });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SELFIE_CONSENT_REQUIRED');
    }
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('says so when the selfie shows no face', async () => {
    mockDetect.mockResolvedValue({ model_version: MODEL, faces: [] });
    const res = await search();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SELFIE_NO_FACE');
  });

  it('refuses a file that is not an image, and a missing file', async () => {
    const res = await search({ file: Buffer.from('not an image') });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SELFIE_INVALID');
    expect((await search({ file: null })).body.code).toBe('SELFIE_INVALID');
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('answers 503 while the sidecar is down', async () => {
    const { SidecarUnavailableError } = jest.requireActual('../../src/services/faceClient');
    mockDetect.mockRejectedValue(new SidecarUnavailableError('ECONNREFUSED'));
    const res = await search();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SELFIE_SEARCH_UNAVAILABLE');
  });

  it.each([
    ['the event did not opt in', { face_selfie_search_enabled: 0 }],
    ['face detection is off for the event', { face_recognition_enabled: 0 }],
    ['the people bar is hidden from guests', { faces_visible_to_guests: 0 }],
    ['the gallery is hidden until its reveal', { reveal_mode: 1 }],
  ])('is a 404 when %s', async (_label, changes) => {
    await db('events').where({ id: eventId }).update(changes);
    const res = await search();
    expect(res.status).toBe(404);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('is a 404 with the faces feature flag off', async () => {
    await setFlag(false);
    expect((await search()).status).toBe(404);
  });

  it('allows five searches per ten minutes from one address', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 5; i += 1) expect((await search({ ip })).status).toBe(200);
    const res = await search({ ip });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('SELFIE_SEARCH_RATE_LIMITED');
  });

  it('tells the gallery whether to offer the search', async () => {
    const on = await request(app).get(`/api/gallery/${SLUG}/photos`);
    expect(on.body.event.selfie_search_enabled).toBe(true);
    await db('events').where({ id: eventId }).update({ face_selfie_search_enabled: 0 });
    const off = await request(app).get(`/api/gallery/${SLUG}/photos`);
    expect(off.body.event.selfie_search_enabled).toBe(false);
    expect(off.body.event.people_enabled).toBe(true);
  });

  it('lets the admin switch it per event', async () => {
    await db('events').where({ id: eventId }).update({ face_selfie_search_enabled: 0 });
    const auth = (r) => r.set('Authorization', `Bearer ${adminToken}`);
    expect((await auth(request(app).get(`/api/admin/events/${eventId}/faces`))).body.selfie_search).toBe(false);
    const patch = await auth(request(app).patch(`/api/admin/events/${eventId}/faces`)).send({ selfie_search: true });
    expect(patch.status).toBe(200);
    expect((await auth(request(app).get(`/api/admin/events/${eventId}/faces`))).body.selfie_search).toBe(true);
    expect((await auth(request(app).patch(`/api/admin/events/${eventId}/faces`)).send({ selfie_search: 'maybe' })).status).toBe(400);
  });
});
