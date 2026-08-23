/**
 * Hidden feedback, seen from the guest who left it (#1150).
 *
 * Everything in the system treats a hidden row as absent: getPhotoFeedback
 * drops it even for the guest's own feedback, the /photos filters drop it, and
 * updatePhotoFeedbackStats does not count it. Two places disagreed — the
 * per-viewer `is_liked` heart and the `my_color_label` badge — so a like the
 * photographer had hidden still showed as liked on a photo whose like_count
 * was zero.
 *
 * Making those two agree exposes the second half: the duplicate check that
 * powers like/favorite toggling did NOT skip hidden rows, so the now-empty
 * heart, when clicked, found the hidden row and toggled it OFF. The click
 * appeared to do nothing and it took two more to get back to a filled heart.
 *
 * Hiding a non-comment is deliberate, not an accident of the raw route: #839
 * and #1044 both ship it, with tests asserting that a hidden reaction or
 * colour label stops counting. So the fix is to make hidden mean absent
 * consistently — not to stop admins hiding these.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'hidden-feedback-secret';

const SLUG = 'hidden-own-feedback';
const ME = 'guest-me-identifier';

describe('a guest\'s own hidden feedback (#1150)', () => {
  let db; let cleanup; let app; let feedbackService;
  let eventId; let photoId; let myGuestRowId;

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

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    feedbackService = require('../../src/services/feedbackService');

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Hidden Own Feedback',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'hidden-own-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'shot.jpg', path: 'events/hidden/shot.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    const [g] = await db('gallery_guests').insert({
      event_id: eventId, name: 'Me', identifier: ME,
      created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      is_deleted: false,
    }).returning('id');
    myGuestRowId = typeof g === 'object' ? g.id : g;

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_likes: true,
      allow_color_labels: true, moderate_comments: false,
      show_feedback_to_guests: true,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const like = () => db('photo_feedback').insert({
    photo_id: photoId, event_id: eventId, guest_identifier: ME,
    guest_id: myGuestRowId, feedback_type: 'like',
    is_approved: true, is_hidden: false, created_at: new Date().toISOString(),
  });

  beforeEach(async () => {
    await db('photo_feedback').where({ photo_id: photoId }).del();
    await db('photos').where('id', photoId).update({ like_count: 0, color_label_count: 0 });
  });

  describe('the read surfaces agree with each other', () => {
    it('un-fills the heart once the like is hidden', async () => {
      await like();
      await feedbackService.updatePhotoFeedbackStats(photoId);
      expect((await getPhoto()).is_liked).toBe(true);

      await db('photo_feedback')
        .where({ photo_id: photoId, feedback_type: 'like' })
        .update({ is_hidden: true });
      await feedbackService.updatePhotoFeedbackStats(photoId);

      const photo = await getPhoto();
      // like_count already ignored hidden rows, so the heart was the only
      // thing still claiming this photo was liked.
      expect(photo.like_count).toBe(0);
      expect(photo.is_liked).toBe(false);
    });

    it('drops a hidden colour label from the badge', async () => {
      await db('photo_feedback').insert({
        photo_id: photoId, event_id: eventId, guest_identifier: ME,
        guest_id: myGuestRowId, feedback_type: 'color_label', color_label: 'green',
        is_approved: true, is_hidden: true, created_at: new Date().toISOString(),
      });
      expect((await getPhoto()).my_color_label).toBeFalsy();
    });
  });

  describe('and clicking still works afterwards', () => {
    it('re-liking creates a fresh row instead of toggling the hidden one off', async () => {
      await like();
      await db('photo_feedback')
        .where({ photo_id: photoId, feedback_type: 'like' })
        .update({ is_hidden: true });

      // What the guest sees is an empty heart, so this is an ADD.
      const result = await feedbackService.submitFeedback(photoId, eventId, {
        feedback_type: 'like',
        guest_identifier: ME,
        guest_id: myGuestRowId,
      });

      // Before this, the duplicate check found the hidden row and deleted it —
      // `removed: true` — so the click did nothing visible and the moderation
      // was silently undone.
      expect(result.removed).toBeUndefined();

      const visible = await db('photo_feedback')
        .where({ photo_id: photoId, feedback_type: 'like', is_hidden: false });
      expect(visible).toHaveLength(1);
      expect((await getPhoto()).is_liked).toBe(true);
    });
  });

});
