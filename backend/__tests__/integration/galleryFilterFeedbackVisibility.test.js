/**
 * Guest filters must respect show_feedback_to_guests (#1044 follow-up).
 *
 * Every filter token on /photos is an OR of two halves: what THIS viewer
 * marked, and what ANYONE marked. The response fields built from the second
 * half — like_count, comment_count, color_label_count — are all gated on
 * show_feedback_to_guests. The FILTER was not.
 *
 * So with the setting off, the numbers were hidden but `?filter=liked` still
 * returned exactly the photos other people had liked: the same information as
 * a set instead of a count, one token at a time. These tests pin the gate on
 * every token, and pin that the viewer's own half is never gated — filtering
 * by what you yourself marked is yours to do regardless.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'filter-visibility-secret';

const SLUG = 'filter-visibility-event';
const ME = 'guest-me-identifier';
const SOMEONE_ELSE = 'guest-other-identifier';

describe('guest filters and show_feedback_to_guests (#1044)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let mine;
  let theirs;
  let myGuestRowId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const setVisibility = (visible) => db('event_feedback_settings')
    .where({ event_id: eventId })
    .update({ show_feedback_to_guests: visible });

  // A real verified guest, which is how the viewer's own feedback is actually
  // identified — NOT the `guest_id` query parameter the frontend invents.
  const guestToken = () => jwt.sign(
    { type: 'guest', guestId: myGuestRowId, eventId },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  // The photo payload itself, not just the filtered id list — `is_liked` and
  // the aggregate counts live here (#1286).
  const payload = async ({ as = 'me' } = {}) => {
    const req = request(app)
      .get(`/api/gallery/${SLUG}/photos`)
      .set('Authorization', `Bearer ${galleryToken()}`);
    if (as === 'me') req.set('x-guest-token', guestToken());
    const res = await req;
    expect(res.status).toBe(200);
    const photos = Array.isArray(res.body) ? res.body : res.body.photos;
    return Object.fromEntries((photos || []).map((p) => [p.id, p]));
  };

  const filter = async (token, { as = 'me', claimGuestId } = {}) => {
    const req = request(app)
      .get(`/api/gallery/${SLUG}/photos`)
      .query({ filter: token, ...(claimGuestId ? { guest_id: claimGuestId } : {}) })
      .set('Authorization', `Bearer ${galleryToken()}`);
    if (as === 'me') req.set('x-guest-token', guestToken());
    const res = await req;
    expect(res.status).toBe(200);
    const photos = Array.isArray(res.body) ? res.body : res.body.photos;
    return (photos || []).map((p) => p.id).sort((a, b) => a - b);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Filter Visibility',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'filter-visibility-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const addPhoto = async (name) => {
      const p = await db('photos').insert({
        event_id: eventId,
        filename: name,
        path: `events/filter/${name}`,
        type: 'individual',
        uploaded_at: new Date().toISOString(),
      }).returning('id');
      return p[0]?.id ?? p[0];
    };
    mine = await addPhoto('mine.jpg');
    theirs = await addPhoto('theirs.jpg');

    await db('event_feedback_settings').insert({
      event_id: eventId,
      feedback_enabled: true,
      allow_likes: true,
      allow_comments: true,
      allow_ratings: true,
      allow_favorites: true,
      allow_color_labels: true,
      moderate_comments: false,
      show_feedback_to_guests: true,
    });

    const guestRow = await db('gallery_guests').insert({
      event_id: eventId,
      name: 'Me',
      identifier: ME,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_deleted: false,
    }).returning('id');
    myGuestRowId = guestRow[0]?.id ?? guestRow[0];

    const feedback = (photoId, who, type, extra = {}) => db('photo_feedback').insert({
      photo_id: photoId,
      event_id: eventId,
      guest_identifier: who,
      // Submission links to the per-person guest row when one is present, and
      // that is the column the viewer's own half resolves through.
      guest_id: who === ME ? myGuestRowId : null,
      feedback_type: type,
      is_approved: true,
      is_hidden: false,
      created_at: new Date().toISOString(),
      ...extra,
    });

    // Everything on `theirs` belongs to somebody else; `mine` is this viewer's.
    await feedback(mine, ME, 'like');
    await feedback(theirs, SOMEONE_ELSE, 'like');
    await feedback(theirs, SOMEONE_ELSE, 'favorite');
    await feedback(theirs, SOMEONE_ELSE, 'comment', { comment_text: 'lovely' });
    await feedback(theirs, SOMEONE_ELSE, 'rating', { rating: 5 });
    await feedback(theirs, SOMEONE_ELSE, 'color_label', { color_label: 'green' });

    // The denormalized counters the aggregate half of the filter reads.
    await db('photos').where('id', theirs).update({
      like_count: 1, favorite_count: 1, comment_count: 1, average_rating: 5, color_label_count: 1,
    });
    await db('photos').where('id', mine).update({ like_count: 1 });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('with feedback visible to guests', () => {
    beforeAll(() => setVisibility(true));

    it('shows other people\'s marks through every token, as before', async () => {
      expect(await filter('liked')).toEqual([mine, theirs].sort((a, b) => a - b));
      expect(await filter('favorited')).toEqual([theirs]);
      expect(await filter('rated')).toEqual([theirs]);
      expect(await filter('commented')).toEqual([theirs]);
      expect(await filter('color:green')).toEqual([theirs]);
    });
  });

  describe('with feedback hidden from guests', () => {
    beforeAll(() => setVisibility(false));

    it('stops every token from selecting on other people\'s marks', async () => {
      // `theirs` is the photo only other guests marked. It must not come back
      // through any token — a filter that selects on hidden feedback reports
      // that feedback just as surely as a count would.
      expect(await filter('favorited')).toEqual([]);
      expect(await filter('rated')).toEqual([]);
      expect(await filter('commented')).toEqual([]);
      expect(await filter('color:green')).toEqual([]);
    });

    it('still filters by what the viewer marked themselves', async () => {
      // The viewer's own half is never gated: this is their own action, and
      // hiding it would break "show me the ones I liked" for no privacy gain.
      expect(await filter('liked')).toEqual([mine]);
    });

    it('drops the viewer\'s own feedback once an admin hides it', async () => {
      // Moderation has to reach the filter too. getPhotoFeedback excludes
      // hidden rows for the guest's OWN feedback, so a photo matching here
      // would come back with nothing visible on it to explain why.
      await db('photo_feedback')
        .where({ photo_id: mine, guest_id: myGuestRowId, feedback_type: 'like' })
        .update({ is_hidden: true });

      expect(await filter('liked')).toEqual([]);

      await db('photo_feedback')
        .where({ photo_id: mine, guest_id: myGuestRowId, feedback_type: 'like' })
        .update({ is_hidden: false });
      expect(await filter('liked')).toEqual([mine]);
    });

    it('ignores a guest_id supplied by the caller', async () => {
      // The own-half is resolved from the request identity. If it honoured the
      // query string instead, anyone holding another guest's identifier could
      // read that guest's hidden memberships one token at a time — straight
      // back through the gate this file exists to pin.
      expect(await filter('favorited', { claimGuestId: SOMEONE_ELSE })).toEqual([]);
      expect(await filter('color:green', { claimGuestId: SOMEONE_ELSE })).toEqual([]);
      // And an anonymous caller claiming to be me gets nothing of mine.
      expect(await filter('liked', { as: 'anon', claimGuestId: ME })).toEqual([]);
    });
  });
  // #1286 — the viewer's OWN like is not other people's feedback.
  describe("a guest's own likes with feedback hidden (#1286)", () => {
    beforeAll(() => setVisibility(false));

    it('still reports is_liked on the photo the viewer liked', async () => {
      // The regression: every heart came back empty on a gallery with
      // sharing off, so the grid looked like it had discarded the guest's
      // choices on every reload.
      const photos = await payload();
      expect(photos[mine].is_liked).toBe(true);
    });

    it("does not report is_liked for someone else's like", async () => {
      const photos = await payload();
      expect(photos[theirs].is_liked).toBe(false);
    });

    it('keeps the aggregate like_count hidden', async () => {
      // The count IS other people's feedback and must stay gated — the fix
      // must not leak it back through the same payload.
      const photos = await payload();
      expect(photos[mine].like_count).toBe(0);
      expect(photos[theirs].like_count).toBe(0);
      expect(photos[theirs].has_feedback).toBe(false);
    });

    it('reports nothing as liked for a viewer who liked nothing', async () => {
      const photos = await payload({ as: 'anon' });
      expect(photos[mine].is_liked).toBe(false);
      expect(photos[theirs].is_liked).toBe(false);
    });

    it("still respects an admin hiding the viewer's own like (#1150)", async () => {
      await db('photo_feedback')
        .where({ photo_id: mine, guest_id: myGuestRowId, feedback_type: 'like' })
        .update({ is_hidden: true });

      const photos = await payload();
      expect(photos[mine].is_liked).toBe(false);

      await db('photo_feedback')
        .where({ photo_id: mine, guest_id: myGuestRowId, feedback_type: 'like' })
        .update({ is_hidden: false });
    });

    it('matches what the liked filter already returned', async () => {
      // The filter half was never gated; the payload flag was. After the fix
      // the two agree, which is what makes the grid and the Likes chip show
      // the same set.
      expect(await filter('liked')).toEqual([mine]);
      const photos = await payload();
      const flagged = Object.values(photos).filter((p) => p.is_liked).map((p) => p.id);
      expect(flagged).toEqual([mine]);
    });
  });

  describe('with feedback visible again (#1286 regression guard)', () => {
    beforeAll(() => setVisibility(true));

    it('is_liked and the counts both come back', async () => {
      const photos = await payload();
      expect(photos[mine].is_liked).toBe(true);
      expect(photos[theirs].is_liked).toBe(false);
      expect(photos[theirs].like_count).toBe(1);
    });
  });
});
