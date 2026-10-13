/**
 * Drawn annotations on a photo comment (issue 1733, item A2).
 *
 * The drawing belongs to the comment row: it is accepted only on a comment
 * and only while the event allows it, is stored re-serialised from the
 * validated structure, and is visible exactly where the comment text is.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'photo-annotations-secret';

const SLUG = 'photo-annotations';
const ANNOTATION = {
  v: 1,
  strokes: [
    { t: 'free', c: 0, p: [[0.1, 0.1], [0.2, 0.25], [0.3, 0.1]] },
    { t: 'arrow', c: 3, p: [[0.9, 0.9], [0.5, 0.5]] },
  ],
};

describe('drawn annotations on a comment (issue 1733)', () => {
  let db; let cleanup; let app;
  let eventId; let photoId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const devices = new Map();
  const device = (name) => {
    if (!devices.has(name)) devices.set(name, request.agent(app));
    return devices.get(name);
  };
  const asGuest = (ua) => ({ 'Authorization': `Bearer ${galleryToken()}`, 'User-Agent': ua });

  const post = (ua, body) => device(ua)
    .post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
    .set(asGuest(ua))
    .send(body);
  const comment = (ua, annotation, text = 'Please brighten this corner') => post(ua, {
    feedback_type: 'comment', comment_text: text, ...(annotation === undefined ? {} : { annotation }),
  });
  const commentsFor = async (ua) => {
    const res = await device(ua)
      .get(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
      .set(asGuest(ua));
    expect(res.status).toBe(200);
    return res.body.feedback.filter((f) => f.feedback_type === 'comment');
  };

  const rows = () => db('photo_feedback').where({ photo_id: photoId }).select('*');
  const setSettings = (patch) => db('event_feedback_settings').where({ event_id: eventId }).update(patch);

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../../src/middleware/feedbackRateLimit', () => ({
      ...jest.requireActual('../../src/middleware/feedbackRateLimit'),
      feedbackRateLimit: () => (_req, _res, next) => next(),
    }));

    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Photo Annotations',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'photo-annotations-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'a.jpg', path: 'events/annotations/a.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_comments: true, allow_likes: true,
      allow_annotations: true, moderate_comments: false,
      show_feedback_to_guests: true, identity_mode: 'simple',
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    devices.clear();
    await db('photo_feedback').where({ event_id: eventId }).del();
    await setSettings({ allow_annotations: true, moderate_comments: false, show_feedback_to_guests: true });
  });

  it('migration 298 defaults the setting to off and exposes it to the guest', async () => {
    const [ev] = await db('events').insert({
      slug: 'annotations-default', event_type: 'wedding', event_name: 'Default',
      event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: '/gallery/annotations-default/share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    const otherId = typeof ev === 'object' ? ev.id : ev;
    await db('event_feedback_settings').insert({ event_id: otherId, feedback_enabled: true });
    const row = await db('event_feedback_settings').where({ event_id: otherId }).first();
    expect(Boolean(row.allow_annotations)).toBe(false);

    const settings = await device('A').get(`/api/gallery/${SLUG}/feedback-settings`).set(asGuest('A'));
    expect(settings.body.allow_annotations).toBe(true);
  });

  it('refuses an annotation while the event has it switched off, and still takes a plain comment', async () => {
    await setSettings({ allow_annotations: false });
    const refused = await comment('A', ANNOTATION);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ANNOTATIONS_DISABLED');
    expect(await rows()).toHaveLength(0);

    expect((await comment('A')).status).toBe(200);
    const [row] = await rows();
    expect(row.annotation).toBeNull();
  });

  it('stores the annotation re-serialised from the validated structure', async () => {
    const sent = {
      strokes: [{ p: [[0.123456789, 0.5], [1, 0]], c: 2, t: 'free' }],
      v: 1,
    };
    const res = await comment('A', sent);
    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row.annotation).toBe('{"v":1,"strokes":[{"t":"free","c":2,"p":[[0.1235,0.5],[1,0]]}]}');
    expect(row.comment_text).toBe('Please brighten this corner');

    const [mine] = await commentsFor('A');
    expect(mine.annotation).toEqual({ v: 1, strokes: [{ t: 'free', c: 2, p: [[0.1235, 0.5], [1, 0]] }] });
  });

  it.each([
    ['a string', JSON.stringify(ANNOTATION)],
    ['an extra key', { ...ANNOTATION, note: 'x' }],
    ['a colour string', { v: 1, strokes: [{ t: 'free', c: 'red', p: [[0, 0], [1, 1]] }] }],
    ['an out-of-range point', { v: 1, strokes: [{ t: 'free', c: 0, p: [[0, 0], [1.5, 1]] }] }],
    ['a markup coordinate', { v: 1, strokes: [{ t: 'arrow', c: 0, p: [['"><svg onload=alert(1)>', 0], [1, 1]] }] }],
    ['no strokes', { v: 1, strokes: [] }],
    ['21 strokes', { v: 1, strokes: Array.from({ length: 21 }, () => ({ t: 'arrow', c: 0, p: [[0, 0], [1, 1]] })) }],
  ])('rejects %s with 400 and stores nothing', async (_label, annotation) => {
    const res = await comment('A', annotation);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ANNOTATION');
    expect(await rows()).toHaveLength(0);
  });

  it('needs the comment text and a comment type', async () => {
    expect((await comment('A', ANNOTATION, '   ')).status).toBe(400);
    const onLike = await post('A', { feedback_type: 'like', annotation: ANNOTATION });
    expect(onLike.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('shows the annotation to other guests exactly when it shows the comment text', async () => {
    expect((await comment('A', ANNOTATION)).status).toBe(200);
    const [row] = await rows();

    // Shared and approved: both the text and the drawing.
    let [seen] = await commentsFor('B');
    expect(seen).toMatchObject({ comment_text: 'Please brighten this corner', annotation: ANNOTATION });

    // Sharing off: another guest gets neither, the author keeps both.
    await setSettings({ show_feedback_to_guests: false });
    expect(await commentsFor('B')).toHaveLength(0);
    expect((await commentsFor('A'))[0]).toMatchObject({ annotation: ANNOTATION, is_mine: true });
    await setSettings({ show_feedback_to_guests: true });

    // Awaiting moderation: the same.
    await db('photo_feedback').where({ id: row.id }).update({ is_approved: false });
    expect(await commentsFor('B')).toHaveLength(0);
    expect((await commentsFor('A'))[0]).toMatchObject({ annotation: ANNOTATION, is_mine: true });

    // Hidden by the photographer: gone for everyone.
    await db('photo_feedback').where({ id: row.id }).update({ is_approved: true, is_hidden: true });
    expect(await commentsFor('B')).toHaveLength(0);
    expect(await commentsFor('A')).toHaveLength(0);
  });

  it('holds the annotation back with a comment that goes to moderation', async () => {
    await setSettings({ moderate_comments: true });
    const res = await comment('A', ANNOTATION);
    expect(res.status).toBe(200);
    expect(await commentsFor('B')).toHaveLength(0);
    const pending = await require('../../src/services/feedbackService').getPendingModeration(eventId);
    expect(pending).toHaveLength(1);
    expect(pending[0].annotation).toEqual(ANNOTATION);
  });

  it('never ships a stored value that does not parse', async () => {
    await comment('A', ANNOTATION);
    const [row] = await rows();
    await db('photo_feedback').where({ id: row.id })
      .update({ annotation: '{"v":1,"strokes":[{"t":"free","c":"\\"><script>","p":[[0,0],[1,1]]}]}' });
    const [seen] = await commentsFor('B');
    expect(seen.comment_text).toBe('Please brighten this corner');
    expect(seen.annotation).toBeNull();
  });

  it('leaves the annotation out of the feedback export', async () => {
    await comment('A', ANNOTATION);
    const feedbackService = require('../../src/services/feedbackService');
    for (const exported of [
      await feedbackService.exportEventFeedback(eventId),
      await feedbackService.exportEventFeedbackPivoted(eventId),
    ]) {
      expect(exported.length).toBeGreaterThan(0);
      expect(JSON.stringify(exported)).not.toContain('strokes');
    }
  });
});
