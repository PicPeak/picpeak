/**
 * Full-resolution zoom in the lightbox (issue 1733).
 *
 * `GET /:slug/photo/:id?zoom=1` hands out the untouched original inline, and
 * only to a viewer who could download exactly those bytes anyway. Pinned:
 *  - every case that takes the feature away is a 403 from the route, not just
 *    a missing `full_resolution_url` in the photo list
 *  - the list and the route agree, because they ask the same function
 *  - a granted request is a view: no download counter, no access log, no grant
 *  - without `zoom=1` the route answers as it always did
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'full-zoom-test-secret';

describe('Full-resolution zoom (issue 1733)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken;
  let jpeg;
  let invalidateDownloadGlobals;
  let slugCounter = 0;

  const galleryToken = (event, extra = {}) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const setSetting = async (key, value) => {
    await db('app_settings').where({ setting_key: key }).del();
    await db('app_settings').insert({
      setting_key: key,
      setting_value: JSON.stringify(value),
      setting_type: 'test',
      updated_at: new Date().toISOString(),
    });
    invalidateDownloadGlobals();
  };

  async function makeEvent(eventFields = {}, photoFields = {}) {
    slugCounter += 1;
    const slug = `zoom-test-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Zoom Test ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `zoom-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
      ...eventFields,
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];

    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    const filename = 'photo-0.jpg';
    await fs.promises.writeFile(path.join(dir, filename), jpeg);
    const p = await db('photos').insert({
      event_id: id,
      filename,
      path: `${slug}/${filename}`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      size_bytes: jpeg.length,
      uploaded_at: new Date().toISOString(),
      ...photoFields,
    }).returning('id');
    const photoId = p[0]?.id ?? p[0];
    const event = await db('events').where({ id }).first();
    return { event, photoId, token: galleryToken(event) };
  }

  const zoom = (event, photoId, token) => request(app)
    .get(`/api/gallery/${event.slug}/photo/${photoId}?zoom=1`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

  // The URL the photo list advertises for the (only) photo, or null.
  const advertised = async (event, token) => {
    const res = await request(app)
      .get(`/api/gallery/${event.slug}/photos`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.photos.length ? res.body.photos[0].full_resolution_url : undefined;
  };

  const refused = async (res) => {
    expect(res.status).toBe(403);
    expect(Buffer.isBuffer(res.body) ? res.body.equals(jpeg) : false).toBe(false);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    ({ invalidateDownloadGlobals } = require('../../src/utils/downloadResolutions'));

    jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 120, b: 200 } },
    }).jpeg().toBuffer();

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'zoom-admin',
      email: 'zoom-admin@example.com',
      password_hash: await bcrypt.hash('ZoomAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'zoom-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await setSetting('branding_watermark_enabled', false);
    await setSetting('download_standard_resolution', 'original');
    await setSetting('download_resolution_picker_enabled', false);
    await setSetting('download_allow_original', false);
  });

  it('serves the untouched original inline and records it as nothing but a view', async () => {
    const { event, photoId, token } = await makeEvent();
    const url = await advertised(event, token);
    expect(url).toBe(`/api/gallery/${event.slug}/photo/${photoId}?zoom=1`);

    const res = await zoom(event, photoId, token);
    expect(res.status).toBe(200);
    expect(res.body.equals(jpeg)).toBe(true);
    expect(res.headers['content-disposition']).toBeUndefined();

    const photo = await db('photos').where({ id: photoId }).first();
    expect(Number(photo.download_count) || 0).toBe(0);
    expect(await db('access_logs').where({ event_id: event.id, action: 'download' })).toHaveLength(0);
    expect(await db('event_download_grants').where({ event_id: event.id })).toHaveLength(0);
  });

  it('refuses when downloads are disabled, for an admin preview too', async () => {
    const { event, photoId, token } = await makeEvent({ allow_downloads: 0 });
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));

    const list = await request(app)
      .get(`/api/gallery/${event.slug}/photos?admin_preview=1`)
      .set('Cookie', [`admin_token=${adminToken}`]);
    expect(list.status).toBe(200);
    expect(list.body.photos[0].full_resolution_url).toBeNull();
    const preview = await request(app)
      .get(`/api/gallery/${event.slug}/photo/${photoId}?zoom=1&admin_preview=1`)
      .set('Cookie', [`admin_token=${adminToken}`]);
    expect(preview.status).toBe(403);
  });

  it('refuses a photo whose category does not allow downloads', async () => {
    const { event, photoId, token } = await makeEvent();
    const cat = await db('photo_categories').insert({
      name: 'Private', slug: `private-${event.id}`, is_global: 0, event_id: event.id, allow_downloads: 0,
    }).returning('id');
    await db('photos').where({ id: photoId }).update({ category_id: cat[0]?.id ?? cat[0] });
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));
  });

  it('refuses while the global watermark is on', async () => {
    const { event, photoId, token } = await makeEvent();
    await setSetting('branding_watermark_enabled', true);
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));
  });

  it('refuses a gallery that watermarks its downloads', async () => {
    const { event, photoId, token } = await makeEvent({ watermark_downloads: 1 });
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));
  });

  it('refuses a gallery whose downloads are held to a reduced resolution', async () => {
    const { event, photoId, token } = await makeEvent({ download_standard_resolution: '1500x1000' });
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));

    // The global standard counts the same way.
    const inherited = await makeEvent();
    await setSetting('download_standard_resolution', '800x600');
    expect(await advertised(inherited.event, inherited.token)).toBeNull();
    await refused(await zoom(inherited.event, inherited.photoId, inherited.token));
  });

  it('allows a reduced standard only where the viewer may still pick the original', async () => {
    const { event, photoId, token } = await makeEvent({
      download_standard_resolution: '1500x1000',
      download_resolution_picker_enabled: 1,
      download_allow_original: 1,
    });
    expect(await advertised(event, token)).toEqual(expect.stringContaining('zoom=1'));
    expect((await zoom(event, photoId, token)).status).toBe(200);

    // An admin preview of a gallery that allows it carries its flag along.
    const list = await request(app)
      .get(`/api/gallery/${event.slug}/photos?admin_preview=1`)
      .set('Cookie', [`admin_token=${adminToken}`]);
    expect(list.body.photos[0].full_resolution_url)
      .toBe(`/api/gallery/${event.slug}/photo/${photoId}?admin_preview=1&zoom=1`);
    await request(app).get(list.body.photos[0].full_resolution_url)
      .set('Cookie', [`admin_token=${adminToken}`]).expect(200);

    // Original allowed but no picker to ask for it with: downloads are reduced.
    await db('events').where({ id: event.id }).update({ download_resolution_picker_enabled: 0 });
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));
  });

  it('refuses every viewer of a gallery with a download limit, granted photos included', async () => {
    const { event, photoId, token } = await makeEvent({ download_limit: 5 });
    const client = galleryToken(event, { accessLevel: 'client' });
    expect(await advertised(event, token)).toBeNull();
    expect(await advertised(event, client)).toBeNull();
    await refused(await zoom(event, photoId, token));
    await refused(await zoom(event, photoId, client));

    // The client downloads it; the original is then theirs, zoom stays off.
    await request(app).get(`/api/gallery/${event.slug}/download/${photoId}`)
      .set('Authorization', `Bearer ${client}`).expect(200);
    // Delivered, not just reserved: the grant settles when the response closes.
    let grants = [];
    for (let i = 0; i < 200; i += 1) {
      grants = await db('event_download_grants').where({ event_id: event.id });
      if (grants.length === 1 && Number(grants[0].pending_holders) === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(Array.from(grants, (row) => Number(row.pending_holders))).toEqual([0]);
    await refused(await zoom(event, photoId, client));
    expect(await db('event_download_grants').where({ event_id: event.id })).toHaveLength(1);
  });

  it('refuses a slideshow token', async () => {
    const { event, photoId } = await makeEvent();
    const show = galleryToken(event, { accessLevel: 'slideshow' });
    expect(await advertised(event, show)).toBeNull();
    await refused(await zoom(event, photoId, show));
  });

  it('refuses a hidden photo to a guest and a photo awaiting review to everyone', async () => {
    const hidden = await makeEvent({}, { visibility: 'hidden' });
    expect(await advertised(hidden.event, hidden.token)).toBeUndefined();
    await refused(await zoom(hidden.event, hidden.photoId, hidden.token));

    const pending = await makeEvent({}, { moderation_status: 'pending' });
    const client = galleryToken(pending.event, { accessLevel: 'client' });
    await refused(await zoom(pending.event, pending.photoId, pending.token));
    await refused(await zoom(pending.event, pending.photoId, client));
  });

  it('refuses a video and an original no browser can render', async () => {
    const video = await makeEvent({}, { media_type: 'video', mime_type: 'video/mp4' });
    expect(await advertised(video.event, video.token)).toBeNull();
    await refused(await zoom(video.event, video.photoId, video.token));

    const raw = await makeEvent({}, { original_filename: 'IMG_0001.CR2' });
    expect(await advertised(raw.event, raw.token)).toBeNull();
    await refused(await zoom(raw.event, raw.photoId, raw.token));
  });

  it.each([
    ['protection level enhanced', { protection_level: 'enhanced' }],
    ['protection level maximum', { protection_level: 'maximum' }],
    ['canvas rendering', { use_canvas_rendering: 1 }],
  ])('refuses a gallery with %s: 403', async (_name, fields) => {
    const { event, photoId, token } = await makeEvent(fields);
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));
  });

  it('allows a gallery with the right-click block, which a level above standard still refuses', async () => {
    const { event, photoId, token } = await makeEvent({ disable_right_click: 1 });
    expect(await advertised(event, token)).toEqual(expect.stringContaining('zoom=1'));
    expect((await zoom(event, photoId, token)).status).toBe(200);
    await db('events').where({ id: event.id }).update({ protection_level: 'enhanced' });
    expect(await advertised(event, token)).toBeNull();
    await refused(await zoom(event, photoId, token));
  });

  it('allows the protection settings every gallery ships with', async () => {
    const { event, photoId, token } = await makeEvent({
      protection_level: 'standard', enable_devtools_protection: 1,
    });
    expect(await advertised(event, token)).toEqual(expect.stringContaining('zoom=1'));
    expect((await zoom(event, photoId, token)).status).toBe(200);
    await db('events').where({ id: event.id }).update({ protection_level: 'basic' });
    expect((await zoom(event, photoId, token)).status).toBe(200);
  });

  it('answers 404 for an expired, archived, inactive or draft gallery', async () => {
    for (const fields of [
      { expires_at: new Date(Date.now() - 3600 * 1000).toISOString() },
      { is_archived: 1 },
      { is_active: 0 },
      { is_draft: 1 },
    ]) {
      const { event, photoId, token } = await makeEvent();
      await db('events').where({ id: event.id }).update(fields);
      const res = await zoom(event, photoId, token);
      expect(res.status).toBe(404);
    }
  });

  it('answers 403 for a token of another gallery and 404 for another gallery\'s photo', async () => {
    const { event, photoId } = await makeEvent();
    const other = await makeEvent();
    expect((await zoom(event, photoId, other.token)).status).toBe(403);
    expect((await zoom(other.event, photoId, other.token)).status).toBe(404);
  });

  it('answers 401 without a token on a password-protected gallery', async () => {
    const { event, photoId } = await makeEvent();
    const res = await request(app).get(`/api/gallery/${event.slug}/photo/${photoId}?zoom=1`);
    expect(res.status).toBe(401);
  });

  it('answers 403 GALLERY_HIDDEN to a guest while the gallery waits for its reveal', async () => {
    const { event, photoId, token } = await makeEvent({ reveal_mode: 1 });
    const res = await request(app).get(`/api/gallery/${event.slug}/photo/${photoId}?zoom=1`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GALLERY_HIDDEN');
  });

  it('answers 403 MUST_CHANGE_PASSWORD to an admin preview that owes a password change', async () => {
    const { event, photoId } = await makeEvent();
    const preview = () => request(app)
      .get(`/api/gallery/${event.slug}/photo/${photoId}?zoom=1&admin_preview=1`)
      .set('Cookie', [`admin_token=${adminToken}`]);
    expect((await preview()).status).toBe(200);
    await db('admin_users').where({ username: 'zoom-admin' }).update({ must_change_password: 1 });
    try {
      const res = await preview();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MUST_CHANGE_PASSWORD');
    } finally {
      await db('admin_users').where({ username: 'zoom-admin' }).update({ must_change_password: 0 });
    }
  });

  it('answers 401 to a session opened before the gallery password changed', async () => {
    const { event, photoId, token } = await makeEvent();
    expect((await zoom(event, photoId, token)).status).toBe(200);
    await db('events').where({ id: event.id })
      .update({ gallery_password_changed_at: new Date(Date.now() + 60 * 1000).toISOString() });
    expect((await zoom(event, photoId, token)).status).toBe(401);
  });

  it('answers 503 in maintenance mode', async () => {
    await db('app_settings').where({ setting_key: 'general_maintenance_mode' }).del();
    await db('app_settings').insert({
      setting_key: 'general_maintenance_mode', setting_value: 'true', setting_type: 'general',
      updated_at: new Date().toISOString(),
    });
    // The gate as server.js mounts it, ahead of the gallery routes. Its
    // one-minute cache is cold: nothing else in this suite goes through it.
    const gated = express();
    gated.use(cookieParser());
    gated.use(require('../../src/middleware/maintenance').maintenanceMiddleware);
    gated.use('/api/gallery', require('../../src/routes/gallery'));
    const { event, photoId, token } = await makeEvent();
    try {
      const res = await request(gated).get(`/api/gallery/${event.slug}/photo/${photoId}?zoom=1`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
    } finally {
      await db('app_settings').where({ setting_key: 'general_maintenance_mode' }).del();
    }
  });

  // Two-stage delivery (issue 1562) has no withheld photo row: what is not
  // delivered yet is not in the gallery at all, and a first-look photo is a
  // delivered one. Pinned so a later per-photo stage has to revisit this.
  it('serves a first-look photo of a partly delivered gallery like any delivered photo', async () => {
    const { event, photoId, token } = await makeEvent(
      { delivery_status: 'partial', delivery_expected_count: 40 }, { first_look: 1 });
    expect((await zoom(event, photoId, token)).status).toBe(200);
  });

  it('carries the cache headers of the original route and revalidates by ETag only once allowed', async () => {
    const { event, photoId, token } = await makeEvent();
    const plain = await request(app).get(`/api/gallery/${event.slug}/photo/${photoId}`)
      .set('Authorization', `Bearer ${token}`);
    const res = await zoom(event, photoId, token);
    expect(res.headers['cache-control']).toBe('private, max-age=1800');
    expect(res.headers['cache-control']).toBe(plain.headers['cache-control']);
    expect(res.headers.etag).toBe(plain.headers.etag);

    const revalidated = await zoom(event, photoId, token).set('If-None-Match', res.headers.etag);
    expect(revalidated.status).toBe(304);

    // A validator the browser still holds must not outlive the permission.
    await db('events').where({ id: event.id }).update({ allow_downloads: 0 });
    const afterwards = await zoom(event, photoId, token).set('If-None-Match', res.headers.etag);
    expect(afterwards.status).toBe(403);
  });

  // Like the original route: a managed photo is streamed whole, a Range
  // header on an image is not honoured (only videos are served in ranges).
  it('ignores Range on an image, as the original route does', async () => {
    const { event, photoId, token } = await makeEvent();
    const res = await zoom(event, photoId, token).set('Range', 'bytes=0-9');
    expect(res.status).toBe(200);
    expect(res.body.equals(jpeg)).toBe(true);
  });

  it('leaves the route without zoom=1 as it was', async () => {
    const off = await makeEvent({ allow_downloads: 0 });
    const redirected = await request(app)
      .get(`/api/gallery/${off.event.slug}/photo/${off.photoId}`)
      .set('Authorization', `Bearer ${off.token}`);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.location).toBe(`/api/gallery/${off.event.slug}/preview/${off.photoId}`);

    // A reduced download standard never touched the display route.
    const reduced = await makeEvent({ download_standard_resolution: '1500x1000' });
    const shown = await request(app)
      .get(`/api/gallery/${reduced.event.slug}/photo/${reduced.photoId}`)
      .set('Authorization', `Bearer ${reduced.token}`);
    expect(shown.status).toBe(200);
  });

  // Issue 2076: the per-event flag has to cover the inline full-size route as
  // well, or a guest simply saves /photo/:id instead of /download/:id.
  describe('plain photo route and the per-event watermark flag (issue 2076)', () => {
    const plain = (event, photoId, token) => request(app)
      .get(`/api/gallery/${event.slug}/photo/${photoId}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

    it('serves the original bytes when neither watermark is on', async () => {
      const { event, photoId, token } = await makeEvent();
      const res = await plain(event, photoId, token);
      expect(res.status).toBe(200);
      expect(res.body.equals(jpeg)).toBe(true);
    });

    it('watermarks the response when only the event flag is on', async () => {
      const { event, photoId, token } = await makeEvent({ watermark_downloads: 1, watermark_text: 'PROOF' });
      const res = await plain(event, photoId, token);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/jpeg/);
      expect(res.body.equals(jpeg)).toBe(false);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('versions the listed photo URL by the event flag, so a flip is not served from cache', async () => {
      const urlOf = async (event, token) => (await request(app)
        .get(`/api/gallery/${event.slug}/photos`)
        .set('Authorization', `Bearer ${token}`)).body.photos[0].url;
      const plainEvent = await makeEvent();
      expect(await urlOf(plainEvent.event, plainEvent.token)).not.toMatch(/wm=/);
      const marked = await makeEvent({ watermark_downloads: 1 });
      expect(await urlOf(marked.event, marked.token)).toMatch(/[?&]wm=ev(&|$)/);
    });
  });
});
