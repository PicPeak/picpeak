/**
 * An uploader name is not a feedback identity (issue 1561).
 *
 * Registering a name from the upload dialog installs a guest token that the
 * frontend sends on every gallery request. Outside guest identity mode,
 * feedback is anonymous per browser; the token must not change that:
 *  - the guest's likes made before the upload stay theirs, and a second click
 *    toggles the same like instead of adding another
 *  - a comment never carries the upload name, which the upload dialog
 *    promises other guests do not see
 *  - the feedback email requirement does not apply to an upload-only name
 *  - a token issued another way (invite redemption) is scoped the same way
 * In guest identity mode the registered guest is the feedback identity, as
 * before.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'uploader-identity-secret';

describe('uploader identity scope (issue 1561)', () => {
  let db; let cleanup; let app;
  let counter = 0;

  const galleryToken = (event) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent(identityMode, feedback = {}) {
    counter += 1;
    const slug = `uploader-scope-${counter}`;
    const [ev] = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Uploader Scope ${counter}`,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `uploader-scope-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      allow_user_uploads: 1,
      guest_name_mode: 'required',
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = typeof ev === 'object' ? ev.id : ev;
    const [p] = await db('photos').insert({
      event_id: id, filename: 'shot.jpg', path: `events/${slug}/shot.jpg`,
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    await db('event_feedback_settings').insert({
      event_id: id, feedback_enabled: true, allow_likes: true, allow_comments: true,
      moderate_comments: false, show_feedback_to_guests: true,
      identity_mode: identityMode, ...feedback,
    });
    const event = await db('events').where({ id }).first();
    return { event, photoId: typeof p === 'object' ? p.id : p, token: galleryToken(event) };
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  // One browser: the agent keeps the anonymous feedback cookie.
  function browser(event, token) {
    const agent = request.agent(app);
    let guestToken = null;
    const auth = (req) => {
      req.set('Authorization', `Bearer ${token}`);
      if (guestToken) req.set('x-guest-token', guestToken);
      return req;
    };
    return {
      async register(name, email) {
        const res = await auth(agent.post(`/api/gallery/${event.slug}/guest`)).send({ name, email });
        if (res.status === 200) guestToken = res.body.token;
        return res;
      },
      feedback: (photoId, body) => auth(agent.post(`/api/gallery/${event.slug}/photos/${photoId}/feedback`)).send(body),
      myFeedback: () => auth(agent.get(`/api/gallery/${event.slug}/my-feedback`)),
      photos: () => auth(agent.get(`/api/gallery/${event.slug}/photos`)),
      photoFeedback: (photoId) => auth(agent.get(`/api/gallery/${event.slug}/photos/${photoId}/feedback`)),
    };
  }

  const visibleLikes = (photoId) => db('photo_feedback')
    .where({ photo_id: photoId, feedback_type: 'like', is_hidden: false });

  describe('simple mode', () => {
    it('keeps the likes made before the upload name, and toggles the same one', async () => {
      const { event, photoId, token } = await makeEvent('simple');
      const guest = browser(event, token);

      expect((await guest.feedback(photoId, { feedback_type: 'like' })).status).toBe(200);
      expect((await guest.register('Anna')).status).toBe(200);

      const mine = await guest.myFeedback();
      expect(mine.status).toBe(200);
      expect(mine.body.map((f) => f.feedback_type)).toContain('like');

      const photos = await guest.photos();
      const tile = (photos.body.photos || photos.body).find((p) => p.id === photoId);
      expect(tile.is_liked).toBe(true);

      // The second click removes the like; it does not add a second one.
      expect((await guest.feedback(photoId, { feedback_type: 'like' })).status).toBe(200);
      expect(await visibleLikes(photoId)).toHaveLength(0);
    });

    it('never puts the upload name on feedback', async () => {
      const { event, photoId, token } = await makeEvent('simple');
      const guest = browser(event, token);
      expect((await guest.register('Anna Uploader')).status).toBe(200);

      expect((await guest.feedback(photoId, { feedback_type: 'like' })).status).toBe(200);
      expect((await guest.feedback(photoId, { feedback_type: 'comment', comment_text: 'Lovely' })).status).toBe(200);

      const rows = await db('photo_feedback').where({ photo_id: photoId });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.guest_id).toBeNull();
        expect(row.guest_name).not.toBe('Anna Uploader');
      }

      // What another guest reads carries no name either.
      const other = browser(event, token);
      const seen = await other.photoFeedback(photoId);
      expect(seen.status).toBe(200);
      expect(JSON.stringify(seen.body)).not.toContain('Anna Uploader');
    });

    it('scopes a redeemed invite the same way', async () => {
      const { event, photoId, token } = await makeEvent('simple');
      const [g] = await db('gallery_guests').insert({
        event_id: event.id, name: 'Dora Invited', identifier: `dora-${event.id}`,
        created_at: new Date().toISOString(), is_deleted: false,
      }).returning('id');
      const guestId = typeof g === 'object' ? g.id : g;
      await db('guest_invites').insert({
        event_id: event.id, guest_id: guestId, token: `invite-${event.id}`,
        created_at: new Date().toISOString(),
      });
      const agent = request.agent(app);
      const redeemed = await agent.post(`/api/gallery/${event.slug}/guest/redeem`)
        .set('Authorization', `Bearer ${token}`)
        .send({ inviteToken: `invite-${event.id}` });
      expect(redeemed.status).toBe(200);
      expect(jwt.decode(redeemed.body.token).scope).toBe('upload');

      const liked = await agent.post(`/api/gallery/${event.slug}/photos/${photoId}/feedback`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-guest-token', redeemed.body.token)
        .send({ feedback_type: 'like' });
      expect(liked.status).toBe(200);
      const [row] = await visibleLikes(photoId);
      expect(row.guest_id).toBeNull();
    });

    it('does not ask an upload-only name for the feedback email', async () => {
      const { event, token } = await makeEvent('simple', { require_name_email: true });
      expect((await browser(event, token).register('Anna')).status).toBe(200);
    });
  });

  describe('shared mode', () => {
    it('keeps the upload name off feedback too', async () => {
      const { event, photoId, token } = await makeEvent('shared');
      const guest = browser(event, token);
      expect((await guest.register('Bea Uploader')).status).toBe(200);
      expect((await guest.feedback(photoId, { feedback_type: 'like' })).status).toBe(200);
      const [row] = await visibleLikes(photoId);
      expect(row.guest_id).toBeNull();
    });
  });

  describe('guest mode', () => {
    it('uses the registered guest for feedback, as before', async () => {
      const { event, photoId, token } = await makeEvent('guest');
      const guest = browser(event, token);
      const reg = await guest.register('Cleo');
      expect(reg.status).toBe(200);
      expect(jwt.decode(reg.body.token).scope).toBeUndefined();

      expect((await guest.feedback(photoId, { feedback_type: 'like' })).status).toBe(200);
      const [row] = await visibleLikes(photoId);
      expect(Number(row.guest_id)).toBe(Number(reg.body.guest.id));
    });

    it('still requires the feedback email there', async () => {
      const { event, token } = await makeEvent('guest', { require_name_email: true });
      const res = await browser(event, token).register('Cleo');
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('email');
    });
  });
});
