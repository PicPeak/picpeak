/**
 * Per-viewer `my_rating` on the gallery photo list (issue 1733, A3a).
 *
 * The grid tile renders a star control, so the list has to carry the
 * viewer's own rating the way it already carries `is_liked` and
 * `my_color_label`: resolved by the same identity, hidden rows absent, and
 * null whenever ratings are switched off for the event.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'my-rating-secret';

const SLUG = 'my-rating';
const ME = 'guest-me-identifier';
const OTHER = 'guest-other-identifier';

describe('my_rating on the photo list (issue 1733)', () => {
  let db; let cleanup; let app;
  let eventId; let photoId; let myGuestRowId; let otherGuestRowId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const guestToken = () => jwt.sign(
    { type: 'guest', guestId: myGuestRowId, eventId },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const getPhoto = async () => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/photos`)
      .set('Authorization', `Bearer ${galleryToken()}`)
      .set('x-guest-token', guestToken());
    expect(res.status).toBe(200);
    const photos = Array.isArray(res.body) ? res.body : res.body.photos;
    return (photos || []).find((p) => p.id === photoId);
  };

  const rate = (who, rating, extra = {}) => db('photo_feedback').insert({
    photo_id: photoId, event_id: eventId, feedback_type: 'rating', rating,
    guest_identifier: who === 'me' ? ME : OTHER,
    guest_id: who === 'me' ? myGuestRowId : otherGuestRowId,
    is_approved: true, is_hidden: false, created_at: new Date().toISOString(),
    ...extra,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'My Rating',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'my-rating-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'shot.jpg', path: 'events/my-rating/shot.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    const guests = await db('gallery_guests').insert([
      { event_id: eventId, name: 'Me', identifier: ME,
        created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), is_deleted: false },
      { event_id: eventId, name: 'Other', identifier: OTHER,
        created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), is_deleted: false },
    ]).returning('id');
    [myGuestRowId, otherGuestRowId] = guests.map((g) => (typeof g === 'object' ? g.id : g));

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_ratings: true,
      allow_likes: true, moderate_comments: false, show_feedback_to_guests: true,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('photo_feedback').where({ photo_id: photoId }).del();
    await db('event_feedback_settings').where({ event_id: eventId })
      .update({ feedback_enabled: true, allow_ratings: true, show_feedback_to_guests: true });
  });

  it('is null when the viewer has not rated', async () => {
    expect((await getPhoto()).my_rating).toBeNull();
  });

  it('carries the viewer\'s own rating', async () => {
    await rate('me', 4);
    expect((await getPhoto()).my_rating).toBe(4);
  });

  it('shows the newest of two rows for the same viewer and photo', async () => {
    // submitFeedback's check-then-insert can leave two rating rows behind;
    // the tile must agree with the lightbox, which reads newest-first.
    await rate('me', 2, { created_at: '2026-01-01T10:00:00.000Z' });
    await rate('me', 5, { created_at: '2026-01-01T10:00:01.000Z' });
    expect((await getPhoto()).my_rating).toBe(5);
    // Same second: the later id wins.
    await db('photo_feedback').where({ photo_id: photoId }).del();
    await rate('me', 3, { created_at: '2026-01-01T11:00:00.000Z' });
    await rate('me', 1, { created_at: '2026-01-01T11:00:00.000Z' });
    expect((await getPhoto()).my_rating).toBe(1);
  });

  it('getPhotoFeedback puts the newest of two same-second rows first, like my_rating', async () => {
    const feedbackService = require('../../src/services/feedbackService');
    await rate('me', 3, { created_at: '2026-01-01T11:00:00.000Z' });
    await rate('me', 1, { created_at: '2026-01-01T11:00:00.000Z' });
    const rows = await feedbackService.getPhotoFeedback(photoId, { guest_id: myGuestRowId });
    expect(rows.find((r) => r.feedback_type === 'rating').rating).toBe(1);
    expect((await getPhoto()).my_rating).toBe(1);
  });

  it('lets the row that was changed last win over a newer untouched duplicate', async () => {
    // A duplicate pair where the OLDER row was updated afterwards: by
    // created_at alone both readers would keep showing the stale newer row.
    const feedbackService = require('../../src/services/feedbackService');
    await rate('me', 4, { created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T12:00:00.000Z' });
    await rate('me', 2, { created_at: '2026-01-01T11:00:00.000Z', updated_at: '2026-01-01T11:00:00.000Z' });

    expect((await getPhoto()).my_rating).toBe(4);
    const rows = await feedbackService.getPhotoFeedback(photoId, { guest_id: myGuestRowId });
    expect(rows.find((r) => r.feedback_type === 'rating').rating).toBe(4);
    // The sort key stays inside the service.
    expect(rows.every((r) => !('updated_at' in r))).toBe(true);
  });

  it('reads epoch-ms and SQL-text timestamps as the same clock', () => {
    // SQLite holds ms where a Date was bound and text where the default ran.
    const { lastMutatedFirst } = require('../../src/services/feedbackService');
    const older = { id: 1, created_at: '2026-01-01 10:00:00', updated_at: '2026-01-01 10:00:00' };
    const newer = { id: 2, created_at: '2026-01-01 09:00:00', updated_at: Date.parse('2026-01-01T10:00:01Z') };
    expect([older, newer].sort(lastMutatedFirst).map((r) => r.id)).toEqual([2, 1]);
  });

  it('changing a rating collapses duplicate rows to the one that was changed', async () => {
    const feedbackService = require('../../src/services/feedbackService');
    await rate('me', 2, { created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' });
    await rate('me', 5, { created_at: '2026-01-01T10:00:01.000Z', updated_at: '2026-01-01T10:00:01.000Z' });
    await rate('other', 1);

    await feedbackService.submitFeedback(photoId, eventId, { feedback_type: 'rating', rating: 3, guest_id: myGuestRowId }, ME);

    const mine = await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'rating', guest_id: myGuestRowId });
    expect(Array.from(mine).map((r) => Number(r.rating))).toEqual([3]);
    // Another viewer's rating is not part of the collapse.
    expect(await db('photo_feedback').where({ photo_id: photoId, guest_id: otherGuestRowId }).count('id as c').first())
      .toMatchObject({ c: 1 });
    expect((await getPhoto()).my_rating).toBe(3);
  });

  it('collapses conflicting duplicates even when the submitted value equals the older row', async () => {
    // Rows 2 then 5; the lookup may hand submitFeedback the older one, whose
    // value already equals the submission. The cleanup must not depend on
    // which row was found: one row, value 2, everywhere.
    const feedbackService = require('../../src/services/feedbackService');
    await rate('me', 2, { created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' });
    await rate('me', 5, { created_at: '2026-01-01T10:00:01.000Z', updated_at: '2026-01-01T10:00:01.000Z' });

    await feedbackService.submitFeedback(photoId, eventId, { feedback_type: 'rating', rating: 2, guest_id: myGuestRowId }, ME);

    const mine = await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'rating', guest_id: myGuestRowId });
    expect(Array.from(mine).map((r) => Number(r.rating))).toEqual([2]);
    expect((await getPhoto()).my_rating).toBe(2);
    const rows = await feedbackService.getPhotoFeedback(photoId, { guest_id: myGuestRowId });
    expect(rows.find((r) => r.feedback_type === 'rating').rating).toBe(2);
    // The removed 5 no longer counts in the photo's average.
    expect(Number((await db('photos').where({ id: photoId }).first()).average_rating)).toBe(2);
  });

  it('does not report another viewer\'s rating as mine', async () => {
    await rate('other', 5);
    expect((await getPhoto()).my_rating).toBeNull();
  });

  it('survives show_feedback_to_guests being off, like is_liked', async () => {
    await rate('me', 3);
    await db('event_feedback_settings').where({ event_id: eventId })
      .update({ show_feedback_to_guests: false });
    const photo = await getPhoto();
    expect(photo.my_rating).toBe(3);
    // The aggregate beside it stays hidden.
    expect(photo.average_rating).toBe(0);
  });

  it('drops a rating the photographer has hidden', async () => {
    await rate('me', 4, { is_hidden: true });
    expect((await getPhoto()).my_rating).toBeNull();
  });

  it('is null when ratings are switched off for the event', async () => {
    await rate('me', 4);
    await db('event_feedback_settings').where({ event_id: eventId })
      .update({ allow_ratings: false });
    expect((await getPhoto()).my_rating).toBeNull();
  });
});
