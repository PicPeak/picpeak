/**
 * Word-filter severity tiers, at the submission route.
 *
 * The Settings → Moderation UI advertises `block` as "comment is rejected
 * immediately", but the submit route saved every non-approved comment with
 * is_approved = false — identical handling to `moderate`/`high`. So the
 * strongest tier stored the prohibited text anyway and only hid it from the
 * public list.
 *
 * These three cases pin the tiers apart:
 *   block           → 4xx, nothing written
 *   moderate / high → 201, stored held-for-moderation (is_approved = false)
 *   low             → 201, stored approved (flag-only)
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'block-severity-secret';

const SLUG = 'block-severity';

describe('word-filter severity tiers at submission (#B11)', () => {
  let db; let cleanup; let app;
  let eventId; let photoId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const comment = (text) => request(app)
    .post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
    .set('Authorization', `Bearer ${galleryToken()}`)
    .send({ feedback_type: 'comment', comment_text: text });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Block Severity',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'block-severity-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'shot.jpg', path: `events/${SLUG}/shot.jpg`,
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_comments: true,
      moderate_comments: false, require_name_email: false,
      show_feedback_to_guests: true,
    });

    await db('feedback_word_filters').insert([
      { word: 'zzblocked', severity: 'block', is_active: true, created_at: new Date().toISOString() },
      { word: 'zzmoderated', severity: 'moderate', is_active: true, created_at: new Date().toISOString() },
      { word: 'zzmild', severity: 'low', is_active: true, created_at: new Date().toISOString() },
    ]);
    require('../../src/services/feedbackModeration').clearCache();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('photo_feedback').where({ photo_id: photoId }).del();
  });

  it('rejects a "block" match outright and stores nothing', async () => {
    const res = await comment('this is zzblocked content');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COMMENT_BLOCKED');
    expect(await db('photo_feedback').where({ photo_id: photoId })).toHaveLength(0);
  });

  it('still holds a "moderate" match for moderation', async () => {
    const res = await comment('this is zzmoderated content');

    expect(res.status).toBeLessThan(400);
    const rows = await db('photo_feedback').where({ photo_id: photoId });
    expect(rows).toHaveLength(1);
    expect([false, 0]).toContain(rows[0].is_approved);
    expect(rows[0].comment_text).toContain('zzmoderated');
  });

  it('lets a "low" match through approved (flag only)', async () => {
    const res = await comment('this is zzmild content');

    expect(res.status).toBeLessThan(400);
    const rows = await db('photo_feedback').where({ photo_id: photoId });
    expect(rows).toHaveLength(1);
    expect([true, 1]).toContain(rows[0].is_approved);
  });
});
