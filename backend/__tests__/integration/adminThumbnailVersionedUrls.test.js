/**
 * Admin payloads outside the photo grid hand out thumbnail URLs versioned
 * like the grid's (issue 2276): after an admin picks a video's preview frame,
 * the feedback list, the guest selections and a transfer's files ask for the
 * new frame instead of the hour-cached old one.
 */

const request = require('supertest');
const express = require('express');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('versioned admin thumbnail URLs (issue 2276)', () => {
  let db; let cleanup; let app; let transferService;
  let eventId; let videoId; let photoId; let guest;

  const now = () => new Date().toISOString();
  const firstId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'super_admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
      canAccessEvent: () => true,
      scopeEventsQuery: (query) => query,
    }));

    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    transferService = require('../../src/services/transferService');

    eventId = firstId(await db('events').insert({
      slug: 'versioned-thumbs', event_type: 'wedding', event_name: 'Versioned thumbs',
      event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: '/gallery/versioned-thumbs/share',
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: now(),
    }).returning('id'));
    videoId = firstId(await db('photos').insert({
      event_id: eventId, filename: 'clip.mp4', path: 'versioned-thumbs/clip.mp4', type: 'individual',
      media_type: 'video', mime_type: 'video/mp4', uploaded_at: now(), poster_offset_seconds: 2.5,
    }).returning('id'));
    photoId = firstId(await db('photos').insert({
      event_id: eventId, filename: 'still.jpg', path: 'versioned-thumbs/still.jpg', type: 'individual',
      media_type: 'image', mime_type: 'image/jpeg', uploaded_at: now(),
    }).returning('id'));
    [guest] = await db('gallery_guests').insert({
      event_id: eventId, name: 'Anna', identifier: 'guest-anna', email: 'anna@example.com', is_deleted: false,
    }).returning('*');
    for (const [id, type] of [[videoId, 'like'], [photoId, 'like'], [videoId, 'comment']]) {
      await db('photo_feedback').insert({
        event_id: eventId, photo_id: id, guest_id: guest.id, guest_identifier: guest.identifier,
        feedback_type: type, comment_text: type === 'comment' ? 'Nice' : null,
        is_hidden: false, is_approved: true, created_at: now(), updated_at: now(),
      });
    }

    app = express();
    app.use(express.json());
    app.use('/api/admin/feedback', require('../../src/routes/adminFeedback'));
    app.use('/api/admin', require('../../src/routes/adminGuests'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const videoUrl = () => `/admin/photos/${eventId}/thumbnail/${videoId}?v=p2.5`;
  const photoUrl = () => `/admin/photos/${eventId}/thumbnail/${photoId}`;

  it('the feedback list versions a picked video and keeps the versioning columns out', async () => {
    const res = await request(app).get(`/api/admin/feedback/events/${eventId}/feedback`);
    expect(res.status).toBe(200);
    const byPhoto = (id) => res.body.feedback.filter((row) => row.photo_id === id);
    expect(byPhoto(videoId).map((row) => row.thumbnail_url)).toEqual([videoUrl(), videoUrl()]);
    expect(byPhoto(photoId).map((row) => row.thumbnail_url)).toEqual([photoUrl()]);
    expect(res.body.feedback[0]).not.toHaveProperty('poster_offset_seconds');
    expect(res.body.feedback[0]).not.toHaveProperty('processing_error');
  });

  it('the guest selections aggregate and a guest\'s detail version a picked video', async () => {
    const aggregate = await request(app).get(`/api/admin/events/${eventId}/guests/aggregate`);
    expect(aggregate.status).toBe(200);
    expect(Object.fromEntries(aggregate.body.photos.map((p) => [p.id, p.thumbnail_url]))).toEqual({
      [videoId]: `/api${videoUrl()}`,
      [photoId]: `/api${photoUrl()}`,
    });

    const detail = await request(app).get(`/api/admin/events/${eventId}/guests/${guest.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.selections.liked.map((p) => [p.id, p.thumbnail_url]).sort()).toEqual([
      [videoId, `/api${videoUrl()}`], [photoId, `/api${photoUrl()}`],
    ].sort());
  });

  it('a transfer\'s files version a picked video', async () => {
    await transferService.createTransfer({ title: 'versioned', maxDownloads: null, deliveryMethod: 'email' }, null);
    const transfer = await db('transfers').orderBy('id', 'desc').first();
    await db('transfer_files').insert([
      { transfer_id: transfer.id, photo_id: videoId, sort_order: 1, created_at: now() },
      { transfer_id: transfer.id, photo_id: photoId, sort_order: 2, created_at: now() },
    ]);
    const { files } = await transferService.getTransfer(transfer.id);
    expect(files.map((f) => f.thumbnail_url)).toEqual([videoUrl(), photoUrl()]);
  });

  it('a photo with a placeholder note carries the note version', async () => {
    await db('photos').where({ id: photoId }).update({ processing_error: 'decode failed' });
    try {
      const res = await request(app).get(`/api/admin/feedback/events/${eventId}/feedback`);
      expect(res.body.feedback.find((row) => row.photo_id === photoId).thumbnail_url).toBe(`${photoUrl()}?v=note`);
    } finally {
      await db('photos').where({ id: photoId }).update({ processing_error: null });
    }
  });
});
