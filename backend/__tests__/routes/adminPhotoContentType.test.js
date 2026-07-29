/**
 * Admin photo view route Content-Type (#908).
 *
 * The route built `image/<ext>` from the filename, producing invalid
 * types like image/mp4 for videos. AdminAuthenticatedVideo fetches this
 * URL into a blob whose type inherits the header, and browsers refuse to
 * play a <video> blob labeled image/* — blank/grey admin video preview.
 *
 * Pins (incl. external-review hardening):
 *  - the header is ALWAYS image/* or video/*: a stored non-media MIME
 *    (chunked uploads store the client-sent type unvalidated) is never
 *    echoed — text/html inline under the app origin would be XSS
 *  - stored video/ MIME wins; MIME-less videos map from the extension
 *    (.mov → video/quicktime), unknown video extensions get video/mp4
 *  - images IGNORE the stored MIME (migration 039 backfilled image/jpeg
 *    onto every legacy row, PNGs included) and use the extension,
 *    normalized (jpg → image/jpeg); extensionless files get image/jpeg
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-ct-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-ct-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-ct-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'admin-ct-test-event';

describe('admin photo view Content-Type (#908)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let adminToken;

  const addPhoto = async (filename, extra = {}) => {
    const dir = path.join(process.env.STORAGE_PATH, 'events/active', SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(`bytes-${filename}`));
    const r = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${SLUG}/${filename}`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const getPhotoRes = (photoId) => request(app)
    .get(`/api/admin/photos/${eventId}/photo/${photoId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Admin CT Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'admin-ct-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'admin-ct-admin',
      email: 'admin-ct-admin@example.com',
      password_hash: await bcrypt.hash('AdminCt123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'admin-ct-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('serves a video with its stored mime_type, not image/<ext>', async () => {
    const id = await addPhoto('clip.mp4', { media_type: 'video', mime_type: 'video/mp4' });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('maps MIME-less videos from their extension (.mov → video/quicktime)', async () => {
    const id = await addPhoto('clip-nomime.mov', { media_type: 'video' });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/quicktime');
  });

  it('falls back to video/mp4 for a video with an unknown extension', async () => {
    const id = await addPhoto('clip-unknown.xyz', { media_type: 'video' });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('rejects malformed video/ MIME values that would break setHeader', async () => {
    // Header-invalid chars in the stored value must not 500 the route —
    // fall back to the extension map instead.
    const id = await addPhoto('crlf.mp4', {
      media_type: 'video',
      mime_type: 'video/mp4\r\nX-Evil: 1',
    });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['x-evil']).toBeUndefined();

    const bare = await addPhoto('bare.webm', { media_type: 'video', mime_type: 'video/' });
    const res2 = await getPhotoRes(bare);
    expect(res2.status).toBe(200);
    expect(res2.headers['content-type']).toBe('video/webm');
  });

  it('never echoes a stored non-media MIME type (inline XSS guard)', async () => {
    const id = await addPhoto('evil.png', { mime_type: 'text/html' });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('ignores the migration-039 image/jpeg backfill on legacy PNG rows', async () => {
    const id = await addPhoto('legacy.png', { mime_type: 'image/jpeg' });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('normalizes jpg to the canonical image/jpeg', async () => {
    const id = await addPhoto('shot.jpg');
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('keeps the extension fallback for images without a stored mime_type', async () => {
    const id = await addPhoto('shot.png');
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('does not synthesize types from unmapped image extensions', async () => {
    // Raw interpolation would produce image/svg+xml (scriptable inline)
    // or arbitrary strings from client-controlled filenames — the shared
    // map is the allowlist, everything else is served as image/jpeg.
    const svg = await addPhoto('vector.svg+xml');
    const res = await getPhotoRes(svg);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');

    const weird = await addPhoto('weird.xyz');
    const res2 = await getPhotoRes(weird);
    expect(res2.status).toBe(200);
    expect(res2.headers['content-type']).toBe('image/jpeg');
  });

  it('extensionless files get image/jpeg, never a bare image/', async () => {
    const id = await addPhoto('noext');
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });
});
