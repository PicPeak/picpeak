/**
 * The shared colour tag (#1197).
 *
 * A third identity model, requested in #1178: not "everyone shares a device's
 * state" but "everyone, on any device, shares the PHOTO's state". One
 * identity-less colour tag per photo, and whoever writes last wins.
 *
 * Stored as an ordinary photo_feedback row under a reserved identifier rather
 * than as a column on photos, which is what keeps the per-colour tallies, the
 * filters, the moderation queue and the XMP/CSV export working unchanged: the
 * tally simply has exactly one entry.
 *
 * The mode is scoped to the colour tag. Likes, ratings and the rest stay
 * per-guest, so the last test here is as important as the first.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { SHARED_COLOR_LABEL_IDENTITY } = require('../../src/constants/colorLabels');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'shared-tag-secret';

const SLUG = 'shared-color-tag';

describe('shared colour tag (#1197)', () => {
  let db; let cleanup; let app; let feedbackService;
  let eventId; let photoId; let otherPhotoId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  // Two different devices: distinct UA strings give distinct
  // generateGuestIdentifier hashes, which is exactly how `simple` mode tells
  // two anonymous guests apart.
  const asGuest = (ua) => ({ 'Authorization': `Bearer ${galleryToken()}`, 'User-Agent': ua });

  const tag = (ua, color, id = photoId) => request(app)
    .post(`/api/gallery/${SLUG}/photos/${id}/feedback`)
    .set(asGuest(ua))
    .send({ feedback_type: 'color_label', color_label: color });

  const photosFor = async (ua, query = '') => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/photos${query}`)
      .set(asGuest(ua));
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : res.body.photos;
  };
  const photoFor = async (ua) => (await photosFor(ua)).find((p) => p.id === photoId);

  const feedbackFor = async (ua) => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
      .set(asGuest(ua));
    expect(res.status).toBe(200);
    return res.body;
  };

  const sharedRows = () => db('photo_feedback').where({
    photo_id: photoId, feedback_type: 'color_label',
    guest_identifier: SHARED_COLOR_LABEL_IDENTITY,
  });

  const setMode = (mode) => db('event_feedback_settings')
    .where({ event_id: eventId }).update({ identity_mode: mode });
  const setSharing = (on) => db('event_feedback_settings')
    .where({ event_id: eventId }).update({ show_feedback_to_guests: on });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    feedbackService = require('../../src/services/feedbackService');

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Shared Colour Tag',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'shared-tag-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'a.jpg', path: 'events/shared/a.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    const [p2] = await db('photos').insert({
      event_id: eventId, filename: 'b.jpg', path: 'events/shared/b.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    otherPhotoId = typeof p2 === 'object' ? p2.id : p2;

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_likes: true,
      allow_color_labels: true, moderate_comments: false,
      show_feedback_to_guests: true, identity_mode: 'shared',
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('photo_feedback').where({ event_id: eventId }).del();
    await db('photos').where('event_id', eventId).update({ color_label_count: 0, like_count: 0 });
    await setMode('shared');
    await setSharing(true);
  });

  describe('one tag per photo, last write wins', () => {
    it('lets a second guest overwrite the first guest\'s colour', async () => {
      // The request in the reporter's words: "if guest A marks a photo green
      // and guest B later marks the same photo orange, the shared tag simply
      // becomes orange".
      expect((await tag('device-A', 'green')).status).toBe(200);
      expect((await tag('device-B', 'blue')).status).toBe(200);

      const rows = await sharedRows().select('color_label');
      expect(rows).toHaveLength(1);
      expect(rows[0].color_label).toBe('blue');
    });

    it('shows the same tag to a guest who never set one', async () => {
      await tag('device-A', 'green');
      // Different device, different identifier — in simple mode this would
      // read back null, which is the whole reason the mode exists.
      expect((await photoFor('device-B')).my_color_label).toBe('green');
    });

    it('stores no attribution against the tag', async () => {
      await tag('device-A', 'green');
      const row = await sharedRows().first();
      expect(row.guest_id).toBeFalsy();
      expect(row.guest_name).toBeFalsy();
      expect(row.guest_email).toBeFalsy();
    });

    it('clears the tag when any guest re-sends the colour already on it', async () => {
      await tag('device-A', 'green');
      // B, not A: clearing is not owned by whoever set it.
      expect((await tag('device-B', 'green')).status).toBe(200);

      expect(await sharedRows().first()).toBeFalsy();
      expect((await photoFor('device-A')).my_color_label).toBeFalsy();
    });

    it('leaves exactly one tag when two guests write at the same instant', async () => {
      // The race the transaction exists for: both writers read "no tag", both
      // insert, and the photo ends up carrying two shared tags — a per-guest
      // tally in the one mode that is supposed to have none.
      await Promise.all([
        tag('device-A', 'green'),
        tag('device-B', 'red'),
        tag('device-C', 'blue'),
      ]);

      const rows = await sharedRows().select('color_label');
      expect(rows).toHaveLength(1);
      expect(['green', 'red', 'blue']).toContain(rows[0].color_label);
    });

    it('keeps the tag on the photo it was set on', async () => {
      await tag('device-A', 'green');
      await tag('device-B', 'red', otherPhotoId);

      const photos = await photosFor('device-C');
      expect(photos.find((p) => p.id === photoId).my_color_label).toBe('green');
      expect(photos.find((p) => p.id === otherPhotoId).my_color_label).toBe('red');
    });
  });

  describe('the aggregates keep their existing shape', () => {
    it('reports the tally as a single colour with a count of one', async () => {
      await tag('device-A', 'green');
      await tag('device-B', 'red');

      // Unchanged consumers — grid badge, XMP export, admin filter — read
      // this map and dominantColorLabel() over it. One entry, so the dominant
      // colour is simply the tag.
      expect(await feedbackService.getPhotoColorLabelCounts(photoId)).toEqual({ red: 1 });
      const photo = await db('photos').where('id', photoId).first();
      expect(photo.color_label_count).toBe(1);
    });

    it('does not render the tag a second time as another viewer\'s dot', async () => {
      await tag('device-A', 'green');
      // The shared row is not filed under device-B, so without the mode check
      // it would come back as "someone else's label" and the tile would show
      // the same green twice — once as the badge, once as a dot beside it.
      const photo = await photoFor('device-B');
      expect(photo.my_color_label).toBe('green');
      expect(photo.other_color_labels || []).toHaveLength(0);
    });
  });

  describe('with show_feedback_to_guests off', () => {
    it('still shows the tag — it is the photo\'s state, not someone else\'s opinion', async () => {
      await tag('device-A', 'green');
      await setSharing(false);

      expect((await photoFor('device-B')).my_color_label).toBe('green');
      expect((await feedbackFor('device-B')).my_feedback.color_label).toBe('green');
    });

    it('still hides the per-colour tallies', async () => {
      await tag('device-A', 'green');
      await setSharing(false);
      expect((await feedbackFor('device-B')).color_labels).toEqual({});
    });

    it('answers a colour filter from the shared tag', async () => {
      await tag('device-A', 'green');
      await setSharing(false);

      // The aggregate half of this filter is gated on sharing; in shared mode
      // the tag counts as the viewer's own, so the filter still works.
      const filtered = await photosFor('device-B', '?filter=color:green');
      expect(filtered.map((p) => p.id)).toEqual([photoId]);
    });
  });

  describe('switching modes is not destructive', () => {
    it('ignores per-guest labels while shared, and gives them back afterwards', async () => {
      await setMode('simple');
      await tag('device-A', 'green');
      await tag('device-B', 'red');
      const perGuestRows = await db('photo_feedback')
        .where({ photo_id: photoId, feedback_type: 'color_label' }).count('* as c').first();
      expect(Number(perGuestRows.c)).toBe(2);

      await setMode('shared');
      // Nothing collapsed, nothing guessed: the shared tag starts empty.
      expect((await photoFor('device-A')).my_color_label).toBeFalsy();
      expect(await sharedRows().first()).toBeFalsy();

      await setMode('simple');
      // ...and every original mark is exactly where its owner left it.
      expect((await photoFor('device-A')).my_color_label).toBe('green');
      expect((await photoFor('device-B')).my_color_label).toBe('red');
    });

    it('keeps the shared tag intact across a round trip through simple mode', async () => {
      await tag('device-A', 'green');
      await setMode('simple');
      await setMode('shared');
      expect((await photoFor('device-B')).my_color_label).toBe('green');
    });
  });

  describe('the mode is scoped to the colour tag', () => {
    it('keeps likes per-guest in shared mode', async () => {
      const like = (ua) => request(app)
        .post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
        .set(asGuest(ua))
        .send({ feedback_type: 'like' });

      expect((await like('device-A')).status).toBe(200);
      expect((await photoFor('device-A')).is_liked).toBe(true);
      // B has not liked it. If 'shared' leaked past colour labels, this would
      // come back true and B's click would un-like A's like.
      expect((await photoFor('device-B')).is_liked).toBe(false);

      await like('device-B');
      const photo = await db('photos').where('id', photoId).first();
      expect(photo.like_count).toBe(2);
    });
  });

  describe('the reserved identity cannot be claimed', () => {
    it('refuses a per-guest write that arrives under it', async () => {
      // Not reachable through the routes — a guest identifier is either a
      // sha256 hex or a server-minted UUID — but a future caller must not be
      // able to write the photo's shared tag as if it were their own.
      await expect(feedbackService.submitFeedback(
        photoId, eventId,
        { feedback_type: 'color_label', color_label: 'green' },
        SHARED_COLOR_LABEL_IDENTITY,
      )).rejects.toThrow('Reserved guest identifier');
    });
  });
});
