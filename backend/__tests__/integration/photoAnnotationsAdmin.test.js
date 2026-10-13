/**
 * Drawn annotations on a photo comment (issue 1733), from the photographer's
 * side: the per-event switch and the admin feedback list.
 */

const request = require('supertest');
const express = require('express');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const ANNOTATION = { v: 1, strokes: [{ t: 'arrow', c: 1, p: [[0.2, 0.2], [0.6, 0.7]] }] };

describe('drawn annotations — admin side (issue 1733)', () => {
  let db; let cleanup; let app; let feedbackService;
  let eventId; let photoId;

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
    feedbackService = require('../../src/services/feedbackService');

    const [ev] = await db('events').insert({
      slug: 'annotations-admin', event_type: 'wedding', event_name: 'Annotations Admin',
      event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: '/gallery/annotations-admin/share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;
    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'a.jpg', path: 'events/annotations-admin/a.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    app = express();
    app.use(express.json());
    app.use('/api/admin/feedback', require('../../src/routes/adminFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('is off without a settings row and persists through the settings route', async () => {
    const before = await request(app).get(`/api/admin/feedback/events/${eventId}/feedback-settings`);
    expect(before.status).toBe(200);
    expect(Boolean(before.body.allow_annotations)).toBe(false);

    const bad = await request(app)
      .put(`/api/admin/feedback/events/${eventId}/feedback-settings`)
      .send({ allow_annotations: 'sometimes' });
    expect(bad.status).toBe(400);

    const saved = await request(app)
      .put(`/api/admin/feedback/events/${eventId}/feedback-settings`)
      .send({ feedback_enabled: true, allow_comments: true, allow_annotations: true });
    expect(saved.status).toBe(200);
    expect(Boolean(saved.body.allow_annotations)).toBe(true);
  });

  it('lists a comment with its parsed annotation, and null for a value that does not parse', async () => {
    await feedbackService.submitFeedback(photoId, eventId, {
      feedback_type: 'comment', comment_text: 'Look here', annotation: ANNOTATION, guest_name: 'Ann',
    }, 'guest-a');
    await feedbackService.submitFeedback(photoId, eventId, {
      feedback_type: 'comment', comment_text: 'Broken', guest_name: 'Bob',
    }, 'guest-b');
    await db('photo_feedback').where({ comment_text: 'Broken' }).update({ annotation: '<svg onload=alert(1)>' });
    // The service validates again: a caller cannot hand it a raw structure.
    await feedbackService.submitFeedback(photoId, eventId, {
      feedback_type: 'comment', comment_text: 'Sneaky', guest_name: 'Cy',
      annotation: { v: 1, strokes: [{ t: 'free', c: 'red', p: [[0, 0], [1, 1]] }] },
    }, 'guest-c');

    const res = await request(app).get(`/api/admin/feedback/events/${eventId}/feedback?type=comment`);
    expect(res.status).toBe(200);
    const byText = Object.fromEntries(res.body.feedback.map((f) => [f.comment_text, f.annotation]));
    expect(byText).toEqual({ 'Look here': ANNOTATION, Broken: null, Sneaky: null });
  });
});
