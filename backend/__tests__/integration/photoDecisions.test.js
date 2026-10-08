/**
 * Approve / reject per photo (issue 744), from the guest's side.
 *
 * Same contract as a colour label: one decision per guest per photo, the same
 * decision again clears it, the other one replaces it. The reason rides in
 * comment_text and can be edited by sending the decision again WITH a reason.
 * Off unless the event switches it on, and per guest even in the shared
 * identity mode, which only ever covered the colour tag.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'photo-decisions-secret';

const SLUG = 'photo-decisions';

describe('approve / reject per photo (issue 744)', () => {
  let db; let cleanup; let app; let feedbackModeration;
  let eventId; let photoId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  // Each device keeps its server-issued anonymous identity cookie.
  const devices = new Map();
  const device = (name) => {
    if (!devices.has(name)) devices.set(name, request.agent(app));
    return devices.get(name);
  };
  const asGuest = (ua) => ({ 'Authorization': `Bearer ${galleryToken()}`, 'User-Agent': ua });

  const decide = (ua, body) => device(ua)
    .post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
    .set(asGuest(ua))
    .send({ feedback_type: 'decision', ...body });

  const photoFor = async (ua) => {
    const res = await device(ua).get(`/api/gallery/${SLUG}/photos`).set(asGuest(ua));
    expect(res.status).toBe(200);
    const photos = Array.isArray(res.body) ? res.body : res.body.photos;
    return photos.find((p) => p.id === photoId);
  };
  const feedbackFor = async (ua) => {
    const res = await device(ua)
      .get(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
      .set(asGuest(ua));
    expect(res.status).toBe(200);
    return res.body;
  };

  const decisionRows = () => db('photo_feedback')
    .where({ photo_id: photoId, feedback_type: 'decision' })
    .select('decision', 'comment_text', 'guest_identifier');
  const counts = () => db('photos').where({ id: photoId }).first('approved_count', 'rejected_count');
  const setSettings = (patch) => db('event_feedback_settings').where({ event_id: eventId }).update(patch);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    feedbackModeration = require('../../src/services/feedbackModeration');

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Photo Decisions',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'photo-decisions-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'a.jpg', path: 'events/decisions/a.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_decisions: true,
      allow_color_labels: true, moderate_comments: false,
      show_feedback_to_guests: true, identity_mode: 'simple',
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    devices.clear();
    await db('photo_feedback').where({ event_id: eventId }).del();
    await db('photos').where({ id: photoId }).update({ approved_count: 0, rejected_count: 0 });
    await setSettings({ allow_decisions: true, identity_mode: 'simple', show_feedback_to_guests: true });
  });

  it('is refused while the event has decisions switched off', async () => {
    await setSettings({ allow_decisions: false });
    const res = await decide('device-A', { decision: 'approved' });
    expect(res.status).toBe(403);
    expect(await decisionRows()).toHaveLength(0);

    const settings = await device('device-A')
      .get(`/api/gallery/${SLUG}/feedback-settings`).set(asGuest('device-A'));
    expect(settings.body.allow_decisions).toBe(false);
  });

  it('rejects a value outside the fixed set and an over-long reason', async () => {
    expect((await decide('device-A', { decision: 'maybe' })).status).toBe(400);
    expect((await decide('device-A', { decision: 'rejected', comment_text: 'x'.repeat(501) })).status).toBe(400);
    expect(await decisionRows()).toHaveLength(0);
  });

  it('approves, toggles off with the same decision, and replaces with the other', async () => {
    expect((await decide('device-A', { decision: 'approved' })).body.created).toBe(true);
    expect(await counts()).toMatchObject({ approved_count: 1, rejected_count: 0 });
    expect((await photoFor('device-A')).my_decision).toBe('approved');

    const cleared = await decide('device-A', { decision: 'approved' });
    expect(cleared.body.removed).toBe(true);
    expect(await decisionRows()).toHaveLength(0);
    expect(await counts()).toMatchObject({ approved_count: 0, rejected_count: 0 });

    await decide('device-A', { decision: 'approved' });
    const switched = await decide('device-A', { decision: 'rejected', comment_text: 'Eyes closed' });
    expect(switched.body.updated).toBe(true);
    expect(await decisionRows()).toEqual([
      expect.objectContaining({ decision: 'rejected', comment_text: 'Eyes closed' }),
    ]);
    expect(await counts()).toMatchObject({ approved_count: 0, rejected_count: 1 });
  });

  it('edits the reason when the same decision comes back with one', async () => {
    await decide('device-A', { decision: 'rejected', comment_text: 'Too dark' });
    const edited = await decide('device-A', { decision: 'rejected', comment_text: 'Crop is off' });
    expect(edited.body.updated).toBe(true);
    expect(await decisionRows()).toEqual([
      expect.objectContaining({ decision: 'rejected', comment_text: 'Crop is off' }),
    ]);

    const mine = await feedbackFor('device-A');
    expect(mine.my_feedback).toMatchObject({ decision: 'rejected', decision_reason: 'Crop is off' });
    expect((await photoFor('device-A')).my_decision_reason).toBe('Crop is off');

    // An empty reason keeps the decision and drops the reason.
    await decide('device-A', { decision: 'rejected', comment_text: '' });
    expect(await decisionRows()).toEqual([
      expect.objectContaining({ decision: 'rejected', comment_text: null }),
    ]);

    // Without a reason the same decision is the toggle again.
    expect((await decide('device-A', { decision: 'rejected' })).body.removed).toBe(true);
  });

  it('refuses a reason with a blocked word, as it refuses such a comment', async () => {
    await db('feedback_word_filters').insert({ word: 'forbiddenword', severity: 'block', is_active: true });
    feedbackModeration.clearCache();
    try {
      const res = await decide('device-A', { decision: 'rejected', comment_text: 'a forbiddenword here' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COMMENT_BLOCKED');
      expect(await decisionRows()).toHaveLength(0);
    } finally {
      await db('feedback_word_filters').where({ word: 'forbiddenword' }).del();
      feedbackModeration.clearCache();
    }
  });

  it('shares that another guest decided, but not their reason', async () => {
    await decide('device-A', { decision: 'rejected', comment_text: 'Not this one' });
    const other = await feedbackFor('device-B');
    const row = other.feedback.find((f) => f.feedback_type === 'decision');
    expect(row).toMatchObject({ decision: 'rejected', comment_text: null });
    expect(other.my_feedback.decision).toBeNull();
    expect(other.summary.rejected_count).toBe(1);
    expect((await photoFor('device-B')).rejected_count).toBe(1);

    // With sharing off the tallies go, the guest's own decision stays.
    await setSettings({ show_feedback_to_guests: false });
    expect((await photoFor('device-B')).rejected_count).toBe(0);
    expect((await photoFor('device-A')).my_decision).toBe('rejected');
  });

  it('stays per guest in the shared identity mode', async () => {
    await setSettings({ identity_mode: 'shared' });
    await decide('device-A', { decision: 'approved' });
    await decide('device-B', { decision: 'rejected' });

    const rows = await decisionRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.guest_identifier !== '__shared__')).toBe(true);
    expect((await photoFor('device-A')).my_decision).toBe('approved');
    expect((await photoFor('device-B')).my_decision).toBe('rejected');
    expect(await counts()).toMatchObject({ approved_count: 1, rejected_count: 1 });
  });

  it('leaves my_decision null while decisions are off for the event', async () => {
    await decide('device-A', { decision: 'approved' });
    await setSettings({ allow_decisions: false });
    expect((await photoFor('device-A')).my_decision).toBeNull();
  });
});
