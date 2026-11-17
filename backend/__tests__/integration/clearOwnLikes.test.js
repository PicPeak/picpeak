/**
 * Issue 2561: a guest who liked many photos by accident could only take the
 * likes back one toggle at a time, and the gallery tiles showed a stale heart
 * (fixed in the frontend layouts), so a click meant as "unlike" sent the
 * toggle the other way and created a like that the lightbox and the admin
 * then showed.
 *
 * This file holds the server half:
 *  - the server's surfaces (the photo list's is_liked, the lightbox's
 *    my_feedback.liked, like_count) agree with each other after every toggle,
 *    including the third toggle a stale tile sends;
 *  - DELETE /:slug/my-feedback/likes takes back exactly the viewer's own
 *    visible likes, nothing of another guest's and no other feedback type.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'clear-own-likes-secret';

const SLUG = 'clear-own-likes';

describe('taking back likes (issue 2561)', () => {
  let db; let cleanup; let app;
  let eventId; let photoIds; let meId; let otherId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const guestToken = (guestId) => jwt.sign(
    { type: 'guest', guestId, eventId },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const as = (req, guestId) => req
    .set('Authorization', `Bearer ${galleryToken()}`)
    .set('x-guest-token', guestToken(guestId));

  const toggleLike = (photoId, guestId = meId) => as(
    request(app).post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`), guestId,
  ).send({ feedback_type: 'like' });
  const clearLikes = (guestId = meId) => as(
    request(app).delete(`/api/gallery/${SLUG}/my-feedback/likes`), guestId,
  );
  const listPhotos = async (guestId = meId) => {
    const res = await as(request(app).get(`/api/gallery/${SLUG}/photos`), guestId);
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : res.body.photos;
  };
  const lightbox = async (photoId, guestId = meId) => {
    const res = await as(request(app).get(`/api/gallery/${SLUG}/photos/${photoId}/feedback`), guestId);
    expect(res.status).toBe(200);
    return res.body;
  };
  const likeRows = (where = {}) => db('photo_feedback').where({ event_id: eventId, feedback_type: 'like', ...where });

  const insertId = (row) => (typeof row === 'object' ? row.id : row);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Clear Own Likes',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'clear-own-likes-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = insertId(ev);

    photoIds = [];
    for (const name of ['a', 'b', 'c']) {
      const [p] = await db('photos').insert({
        event_id: eventId, filename: `${name}.jpg`, path: `events/clear/${name}.jpg`,
        type: 'individual', uploaded_at: new Date().toISOString(),
      }).returning('id');
      photoIds.push(insertId(p));
    }

    const guest = async (name) => insertId((await db('gallery_guests').insert({
      event_id: eventId, name, identifier: `guest-${name}`,
      created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      is_deleted: false,
    }).returning('id'))[0]);
    meId = await guest('me');
    otherId = await guest('other');

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_likes: true, allow_ratings: true,
      moderate_comments: false, show_feedback_to_guests: true, identity_mode: 'guest',
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
    await db('feedback_rate_limits').where({ event_id: eventId }).del();
    await db('photos').where({ event_id: eventId }).update({ like_count: 0, average_rating: 0, visibility: 'visible' });
    await db('event_feedback_settings').where({ event_id: eventId }).update({ allow_likes: true });
  });

  it('keeps the photo list, the lightbox and like_count in step through every toggle', async () => {
    const [photoId] = photoIds;
    const surfaces = async () => {
      const row = (await listPhotos()).find((p) => p.id === photoId);
      const box = await lightbox(photoId);
      return { listLiked: row.is_liked, lightboxLiked: box.my_feedback.liked, likeCount: Number(row.like_count) };
    };

    // The tile like, the lightbox unlike, then the stale tile heart clicked
    // "to unlike": the toggle has no direction, so the third one likes again.
    expect((await toggleLike(photoId)).body.created).toBe(true);
    expect(await surfaces()).toEqual({ listLiked: true, lightboxLiked: true, likeCount: 1 });
    expect((await toggleLike(photoId)).body.removed).toBe(true);
    expect(await surfaces()).toEqual({ listLiked: false, lightboxLiked: false, likeCount: 0 });
    expect((await toggleLike(photoId)).body.created).toBe(true);
    expect(await surfaces()).toEqual({ listLiked: true, lightboxLiked: true, likeCount: 1 });
  });

  it('removes all of the viewer\'s likes and nothing else', async () => {
    for (const photoId of photoIds) expect((await toggleLike(photoId)).status).toBe(200);
    expect((await toggleLike(photoIds[0], otherId)).status).toBe(200);
    // Another feedback type of the same guest stays.
    await as(request(app).post(`/api/gallery/${SLUG}/photos/${photoIds[1]}/feedback`), meId)
      .send({ feedback_type: 'rating', rating: 4 })
      .expect(200);

    const res = await clearLikes();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, removed: 3 });
    expect([...res.body.photo_ids].sort()).toEqual([...photoIds].sort());

    expect(await likeRows({ guest_id: meId })).toHaveLength(0);
    expect(await likeRows({ guest_id: otherId })).toHaveLength(1);
    expect(await db('photo_feedback').where({ guest_id: meId, feedback_type: 'rating' })).toHaveLength(1);

    // Every surface agrees: mine are gone, the other guest's like still counts.
    const mine = await listPhotos();
    expect(mine.map((p) => p.is_liked)).toEqual([false, false, false]);
    const counts = Object.fromEntries(mine.map((p) => [p.id, Number(p.like_count)]));
    expect(counts).toEqual({ [photoIds[0]]: 1, [photoIds[1]]: 0, [photoIds[2]]: 0 });
    expect((await lightbox(photoIds[0])).my_feedback.liked).toBe(false);
    expect((await lightbox(photoIds[0], otherId)).my_feedback.liked).toBe(true);
    const stored = await db('photos').whereIn('id', photoIds).select('id', 'like_count');
    expect(Object.fromEntries(stored.map((p) => [p.id, Number(p.like_count)]))).toEqual(counts);
  });

  it('leaves a like the admin hid as the admin\'s record', async () => {
    await toggleLike(photoIds[0]);
    await likeRows({ guest_id: meId }).update({ is_hidden: true });
    await toggleLike(photoIds[1]);

    const res = await clearLikes();
    expect(res.body.removed).toBe(1);
    expect(await likeRows({ guest_id: meId, is_hidden: true })).toHaveLength(1);
  });

  it('answers with nothing removed when the viewer has no likes', async () => {
    await toggleLike(photoIds[0], otherId);
    const res = await clearLikes();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, removed: 0, photo_ids: [] });
    expect(await likeRows()).toHaveLength(1);
  });

  it('leaves a like on a photo this viewer cannot see', async () => {
    await toggleLike(photoIds[0]);
    await toggleLike(photoIds[1]);
    // The client hid the photo from guests after the like.
    await db('photos').where({ id: photoIds[0] }).update({ visibility: 'hidden' });

    const res = await clearLikes();
    expect(res.body.removed).toBe(1);
    expect(res.body.photo_ids).toEqual([photoIds[1]]);
    expect((await likeRows({ guest_id: meId })).map((r) => r.photo_id)).toEqual([photoIds[0]]);
  });

  it('refuses when likes are off for the gallery', async () => {
    await toggleLike(photoIds[0]);
    await db('event_feedback_settings').where({ event_id: eventId }).update({ allow_likes: false });

    const res = await clearLikes();
    expect(res.status).toBe(403);
    expect(await likeRows({ guest_id: meId })).toHaveLength(1);
  });

  it('finds an anonymous viewer by their browser identity in simple mode', async () => {
    await db('event_feedback_settings').where({ event_id: eventId }).update({ identity_mode: 'simple' });
    try {
      const browser = request.agent(app);
      const otherBrowser = request.agent(app);
      const auth = `Bearer ${galleryToken()}`;
      const like = (agent, photoId) => agent.post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
        .set('Authorization', auth).send({ feedback_type: 'like' });
      await like(browser, photoIds[0]).expect(200);
      await like(browser, photoIds[1]).expect(200);
      await like(otherBrowser, photoIds[0]).expect(200);

      const res = await browser.delete(`/api/gallery/${SLUG}/my-feedback/likes`).set('Authorization', auth);
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(2);
      expect(await likeRows()).toHaveLength(1);
    } finally {
      await db('event_feedback_settings').where({ event_id: eventId }).update({ identity_mode: 'guest' });
    }
  });

  it('needs the guest identity in guest mode', async () => {
    await toggleLike(photoIds[0]);
    const res = await request(app)
      .delete(`/api/gallery/${SLUG}/my-feedback/likes`)
      .set('Authorization', `Bearer ${galleryToken()}`);
    expect(res.status).toBe(401);
    expect(await likeRows({ guest_id: meId })).toHaveLength(1);
  });
});
