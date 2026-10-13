/**
 * Guest uploads with approval (issue 1733, item C3; migration 299).
 *
 * Pins the contract:
 *  - with events.moderate_guest_uploads on, an upload through the gallery's
 *    upload route is stored hidden + pending, like a team upload under review
 *    (migration 269), and the answer says so
 *  - no gallery viewer reaches it: not a guest, not the PIN client, not the
 *    guest who uploaded it; not on the list, the stats, or any media route
 *  - photo.uploaded does not fire while it is held, and fires on approval
 *  - approving through the existing moderation route publishes it; rejecting
 *    keeps the row, hidden
 *  - the bell gets one growing entry for the uploads waiting
 *  - a held upload counts toward the photo cap
 *  - with the setting off nothing changes
 *  - the setting is saved through the event update
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'guest-upload-moderation-secret';

describe('guest uploads with approval (issue 1733)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken;
  let jpeg;
  let webhookFire;
  let slugCounter = 0;

  const galleryToken = (event, extra = {}) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const admin = (req) => req.set('Cookie', [`admin_token=${adminToken}`]).set('Authorization', `Bearer ${adminToken}`);
  const as = (req, token) => req.set('Authorization', `Bearer ${token}`);

  async function makeEvent(overrides = {}, moderated = true) {
    slugCounter += 1;
    const slug = `guest-moderation-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Guest Moderation ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `guest-moderation-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_user_uploads: 1,
      allow_downloads: 1,
      guest_name_mode: 'optional',
      created_at: new Date().toISOString(),
      ...(moderated === null ? {} : { moderate_guest_uploads: moderated ? 1 : 0 }),
      ...overrides,
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'events', 'active', slug), { recursive: true });
    const event = await db('events').where({ id }).first();
    return { event, token: galleryToken(event) };
  }

  function upload(event, token, guestToken) {
    const req = as(request(app).post(`/api/gallery/${event.id}/upload`), token);
    if (guestToken) req.set('x-guest-token', guestToken);
    return req.attach('photos', jpeg, { filename: 'guest.jpg', contentType: 'image/jpeg' });
  }

  /** Upload one photo and let the worker finish it, as the queue would. */
  async function uploadProcessed(event, token, guestToken) {
    const res = await upload(event, token, guestToken);
    expect(res.status).toBe(202);
    const photoId = res.body.photo_ids[0];
    await require('../../src/services/photoProcessor').processPhoto(photoId);
    expect((await db('photos').where({ id: photoId }).first()).processing_status).toBe('complete');
    return { res, photoId };
  }

  const listedIds = async (event, token, guestToken) => {
    const req = as(request(app).get(`/api/gallery/${event.slug}/photos`), token);
    if (guestToken) req.set('x-guest-token', guestToken);
    const res = await req;
    expect(res.status).toBe(200);
    return res.body.photos.map((p) => p.id);
  };

  const moderate = (event, photoIds, action) => admin(request(app)
    .post(`/api/admin/photos/${event.id}/photos/moderation`)).send({ photoIds, action });

  const uploadedHooks = () => webhookFire.mock.calls.filter(([name]) => name === 'photo.uploaded');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } })
      .jpeg().toBuffer();

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const inserted = await db('admin_users').insert({
      username: 'moderation-admin',
      email: 'moderation-admin@example.com',
      password_hash: await bcrypt.hash('ModerationAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    const rootId = inserted[0]?.id || inserted[0];
    adminToken = jwt.sign(
      { id: rootId, username: 'moderation-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    webhookFire = jest.spyOn(require('../../src/services/webhookService'), 'fire').mockResolvedValue(undefined);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/notifications', require('../../src/routes/adminNotifications'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(() => webhookFire.mockClear());

  it('adds events.moderate_guest_uploads, off by default', async () => {
    expect(await db.schema.hasColumn('events', 'moderate_guest_uploads')).toBe(true);
    const { event } = await makeEvent({}, null);
    expect(Boolean(event.moderate_guest_uploads)).toBe(false);
  });

  it('stores a guest upload hidden and pending, and says so', async () => {
    const { event, token } = await makeEvent();
    const { res, photoId } = await uploadProcessed(event, token);
    expect(res.body.held_for_review).toBe(true);
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({
      uploaded_by: 'guest', visibility: 'hidden', moderation_status: 'pending',
    });
    // The worker completed it without announcing it.
    expect(uploadedHooks()).toHaveLength(0);
  });

  it('keeps it from every gallery viewer, the uploader included', async () => {
    const { event, token } = await makeEvent();
    const reg = await as(request(app).post(`/api/gallery/${event.slug}/guest`), token).send({ name: 'Anna' });
    expect(reg.status).toBe(200);
    const { photoId } = await uploadProcessed(event, token, reg.body.token);
    const clientToken = galleryToken(event, { accessLevel: 'client' });

    // Lists: an ordinary guest, the uploader's own session, the PIN client.
    expect(await listedIds(event, token)).not.toContain(photoId);
    expect(await listedIds(event, token, reg.body.token)).not.toContain(photoId);
    expect(await listedIds(event, clientToken)).not.toContain(photoId);

    for (const viewer of [token, clientToken]) {
      const stats = await as(request(app).get(`/api/gallery/${event.slug}/stats`), viewer);
      expect(stats.status).toBe(200);
      expect(Number(stats.body.total_photos)).toBe(0);

      for (const route of ['photo', 'thumbnail', 'preview', 'hero', 'download']) {
        // eslint-disable-next-line no-await-in-loop
        const media = await as(request(app).get(`/api/gallery/${event.slug}/${route}/${photoId}`), viewer)
          .set('x-guest-token', reg.body.token);
        expect([route, media.status]).toEqual([route, 403]);
      }
      const view = await as(request(app).post(`/api/gallery/${event.slug}/photo/${photoId}/view`), viewer);
      expect(view.status).toBe(403);

      const zip = await as(request(app).post(`/api/gallery/${event.slug}/download-selected`), viewer)
        .send({ photo_ids: [photoId] });
      expect(zip.status).toBe(404);
    }

    // The PIN client cannot publish it through its visibility switch either.
    const show = await as(request(app).patch(`/api/gallery/${event.slug}/photos/${photoId}/visibility`), clientToken)
      .send({ visibility: 'visible' });
    expect(show.status).toBe(404);
    expect(await db('photos').where({ id: photoId }).first())
      .toMatchObject({ visibility: 'hidden', moderation_status: 'pending' });

    // The uploader still learns how far processing is, in counts only.
    const row = await db('photos').where({ id: photoId }).first('upload_id');
    const status = await as(request(app).get(`/api/gallery/${event.slug}/uploads/status`), token)
      .query({ ids: row.upload_id });
    expect(status.body).toEqual({ total: 1, pending: 0, processing: 0, complete: 1, failed: 0 });
  });

  it('shows it to the admin as a pending guest upload and publishes it on approval', async () => {
    const { event, token } = await makeEvent();
    const { photoId } = await uploadProcessed(event, token);

    const pending = await admin(request(app).get(`/api/admin/photos/${event.id}/photos`)).query({ moderation: 'pending' });
    expect(pending.status).toBe(200);
    expect(pending.body.photos.map((p) => p.id)).toEqual([photoId]);
    expect(pending.body.photos[0]).toMatchObject({ moderation_status: 'pending', uploaded_by: 'guest', uploaded_by_admin: null });

    // Only approval publishes it.
    const show = await admin(request(app).patch(`/api/admin/photos/${event.id}/photos/${photoId}`)).send({ visibility: 'visible' });
    expect(show.status).toBe(409);

    const approve = await moderate(event, [photoId], 'approve');
    expect(approve.status).toBe(200);
    expect(approve.body).toMatchObject({ updated: 1, moderation: { pending: 0, rejected: 0 } });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ visibility: 'visible', moderation_status: null });

    expect(await listedIds(event, token)).toContain(photoId);
    const thumb = await as(request(app).get(`/api/gallery/${event.slug}/thumbnail/${photoId}`), token);
    expect(thumb.status).toBe(200);

    // Announced now, once.
    expect(uploadedHooks()).toHaveLength(1);
    expect(uploadedHooks()[0][1].photo.id).toBe(photoId);
  });

  it('keeps a rejected upload, hidden', async () => {
    const { event, token } = await makeEvent();
    const { photoId } = await uploadProcessed(event, token);

    const reject = await moderate(event, [photoId], 'reject');
    expect(reject.body).toMatchObject({ updated: 1, moderation: { pending: 0, rejected: 1 } });
    expect(await db('photos').where({ id: photoId }).first()).toMatchObject({ visibility: 'hidden', moderation_status: 'rejected' });
    expect(await listedIds(event, token)).not.toContain(photoId);
    expect(await listedIds(event, galleryToken(event, { accessLevel: 'client' }))).not.toContain(photoId);
    expect(uploadedHooks()).toHaveLength(0);
  });

  it('puts one growing entry in the bell for the uploads waiting', async () => {
    const { event, token } = await makeEvent();
    await upload(event, token);
    await upload(event, token);

    const rows = await db('activity_logs').where({ event_id: event.id, activity_type: 'guest_uploads_pending_review' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ count: 2, eventName: event.event_name });

    const bell = await admin(request(app).get('/api/admin/notifications'));
    expect(bell.status).toBe(200);
    const entry = bell.body.notifications.find((n) => n.id === rows[0].id);
    expect(entry).toMatchObject({ type: 'guest_uploads_pending_review', eventId: event.id, metadata: { count: 2 } });

    // Read: the next upload opens a new entry instead of changing a seen one.
    await db('activity_logs').where({ id: rows[0].id }).update({ read_at: new Date().toISOString() });
    await upload(event, token);
    const after = await db('activity_logs').where({ event_id: event.id, activity_type: 'guest_uploads_pending_review' }).orderBy('id');
    expect(after.map((r) => JSON.parse(r.metadata).count)).toEqual([2, 1]);
  });

  it('moves a grown entry back to the top of the bell, also after it was cleared', async () => {
    const { event, token } = await makeEvent();
    const { id: adminId } = jwt.decode(adminToken);
    // Earlier tests' entries share this second; out of the way of the order.
    await db('activity_logs').update({ created_at: '2026-01-01 00:00:00' });
    await upload(event, token);
    const entry = await db('activity_logs')
      .where({ event_id: event.id, activity_type: 'guest_uploads_pending_review' }).first();

    // An old entry the admin cleared, behind a full page of newer ones. The
    // timestamps carry the shape the column default writes on SQLite.
    const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    await db('activity_logs').where({ id: entry.id }).update({ created_at: stamp(Date.now() - 2 * 3600 * 1000) });
    await db('activity_logs').insert(Array.from({ length: 20 }, (_, i) => ({
      activity_type: 'gallery_viewed',
      actor_type: 'guest',
      metadata: '{}',
      event_id: event.id,
      created_at: stamp(Date.now() - 3600 * 1000 + i * 1000),
    })));
    await db('notification_dismissals').insert({
      admin_id: adminId, activity_log_id: entry.id, dismissed_at: new Date().toISOString(),
    });
    const bellIds = async () => (await admin(request(app).get('/api/admin/notifications')))
      .body.notifications.map((n) => n.id);
    expect(await bellIds()).not.toContain(entry.id);

    await upload(event, token);
    const bell = await admin(request(app).get('/api/admin/notifications'));
    expect(bell.body.notifications).toHaveLength(20);
    expect(bell.body.notifications[0]).toMatchObject({ id: entry.id, metadata: { count: 2 } });
  });

  it('keeps parallel uploads in one entry', async () => {
    const { notifyGuestUploadsPending } = require('../../src/services/uploadReviewService');
    const { event } = await makeEvent();
    await Promise.all(Array.from({ length: 6 }, () => notifyGuestUploadsPending(event, 1)));
    const first = await db('activity_logs').where({ event_id: event.id, activity_type: 'guest_uploads_pending_review' });
    expect(first.map((r) => JSON.parse(r.metadata).count)).toEqual([6]);

    // And into an entry that exists: no increment is lost.
    await Promise.all(Array.from({ length: 6 }, () => notifyGuestUploadsPending(event, 2)));
    const grown = await db('activity_logs').where({ event_id: event.id, activity_type: 'guest_uploads_pending_review' });
    expect(grown.map((r) => JSON.parse(r.metadata).count)).toEqual([18]);
  });

  it('counts a held upload toward the photo cap', async () => {
    const { event, token } = await makeEvent({ photo_cap: 1 });
    expect((await upload(event, token)).status).toBe(202);
    const refused = await upload(event, token);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PHOTO_CAP_REACHED');
    expect(await db('photos').where({ event_id: event.id })).toHaveLength(1);
  });

  it('with the setting off a guest upload is published as before', async () => {
    const { event, token } = await makeEvent({ moderate_guest_uploads: 0 });
    const { res, photoId } = await uploadProcessed(event, token);
    expect(res.body.held_for_review).toBeUndefined();
    const row = await db('photos').where({ id: photoId }).first();
    expect(row.moderation_status).toBeNull();
    expect(row.visibility).not.toBe('hidden');
    expect(await listedIds(event, token)).toContain(photoId);
    expect(uploadedHooks()).toHaveLength(1);
    expect(await db('activity_logs').where({ event_id: event.id, activity_type: 'guest_uploads_pending_review' })).toHaveLength(0);
  });

  it('saves the setting through the event update and returns it', async () => {
    const { event } = await makeEvent({ moderate_guest_uploads: 0 });
    const on = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ moderate_guest_uploads: true });
    expect(on.status).toBe(200);
    expect(Boolean((await db('events').where({ id: event.id }).first()).moderate_guest_uploads)).toBe(true);
    const read = await admin(request(app).get(`/api/admin/events/${event.id}`));
    expect(read.status).toBe(200);
    expect(Boolean(read.body.moderate_guest_uploads)).toBe(true);

    const off = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ moderate_guest_uploads: false });
    expect(off.status).toBe(200);
    expect(Boolean((await db('events').where({ id: event.id }).first()).moderate_guest_uploads)).toBe(false);
  });
});
