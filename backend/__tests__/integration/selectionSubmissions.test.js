/**
 * Finish selection / approve edited photos (issue 1733, A1).
 *
 * A guest hands their picks in, per guest; from then on their likes and
 * favourites are frozen on the server until an admin reopens the submission,
 * while ratings, colour labels and comments stay writable. The `approval`
 * kind does the same for approve / reject. The photographer is told through
 * the activity log, the `selection.submitted` webhook and a queued mail.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

jest.mock('../../src/utils/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'selection-submissions-secret';

const SLUG = 'selection-submissions';

describe('finish selection / approve edited photos (issue 1733)', () => {
  let db; let cleanup; let app; let adminId; let feedbackService;
  let eventId; let photoIds; let guests;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const guestToken = (guest) => jwt.sign(
    { eventId, guestId: guest.id, type: 'guest' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  // Each device keeps its server-issued anonymous identity cookie.
  const devices = new Map();
  const device = (name) => {
    if (!devices.has(name)) devices.set(name, request.agent(app));
    return devices.get(name);
  };
  // `who` is a device name, or a registered guest row.
  const as = (who, method, path) => {
    const agent = typeof who === 'string' ? device(who) : request(app);
    const req = agent[method](`/api/gallery/${SLUG}${path}`).set('Authorization', `Bearer ${galleryToken()}`);
    return typeof who === 'string' ? req : req.set('x-guest-token', guestToken(who));
  };
  const feedback = (who, photoId, body) => as(who, 'post', `/photos/${photoId}/feedback`).send(body);
  const state = async (who) => {
    const res = await as(who, 'get', '/selection');
    expect(res.status).toBe(200);
    return res.body;
  };
  const submit = (who, body = { kind: 'selection' }) => as(who, 'post', '/selection/submit').send(body);
  const admin = (method, path) => request(app)[method](`/api/admin/feedback/events/${eventId}${path}`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
  const setSettings = (patch) => db('event_feedback_settings').where({ event_id: eventId }).update(patch);
  const rows = (type) => db('photo_feedback').where({ event_id: eventId, feedback_type: type });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId);
    feedbackService = require('../../src/services/feedbackService');

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Selection Submissions',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'studio@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'selection-submissions-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const inserted = await db('photos').insert([1, 2, 3].map((n) => ({
      event_id: eventId, filename: `p${n}.jpg`, path: `events/selection/p${n}.jpg`,
      type: 'individual', uploaded_at: new Date().toISOString(),
    }))).returning('id');
    photoIds = inserted.map((row) => (typeof row === 'object' ? row.id : row));

    await db('event_feedback_settings').insert({ event_id: eventId, feedback_enabled: true });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
    app.use('/api/admin/feedback', require('../../src/routes/adminFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    devices.clear();
    for (const table of ['selection_submissions', 'photo_feedback', 'feedback_rate_limits',
      'webhook_deliveries', 'webhooks', 'email_queue', 'activity_logs', 'gallery_guests']) {
      await db(table).where(table === 'webhooks' || table === 'webhook_deliveries' ? {} : { event_id: eventId }).del();
    }
    await setSettings({
      feedback_enabled: true, identity_mode: 'simple', moderate_comments: false,
      allow_likes: true, allow_favorites: true, allow_ratings: true, allow_comments: true,
      allow_color_labels: true, allow_decisions: false, allow_selection_submit: true,
      max_likes_per_guest: null, max_favorites_per_guest: null,
    });
    guests = await db('gallery_guests').insert(['anna', 'ben'].map((name) => ({
      event_id: eventId, name, identifier: `guest-${name}`, email: `${name}@example.com`, is_deleted: false,
    }))).returning('*');
  });

  describe('the counter', () => {
    it('counts against the like cap when that is the cap the gallery uses', async () => {
      await setSettings({ max_likes_per_guest: 5, allow_selection_submit: false });
      await feedback('device-A', photoIds[0], { feedback_type: 'like' });
      await feedback('device-A', photoIds[1], { feedback_type: 'like' });
      // A favourite is not a pick here: the like cap defines the selection.
      await feedback('device-A', photoIds[2], { feedback_type: 'favorite' });

      const { selection } = await state('device-A');
      expect(selection).toMatchObject({ counter: true, can_submit: false, pick_types: ['like'], cap: 5, used: 2 });
    });

    it('counts against the favourites cap, and without a cap counts each picked photo once', async () => {
      await setSettings({ max_favorites_per_guest: 3 });
      await feedback('device-A', photoIds[0], { feedback_type: 'favorite' });
      expect((await state('device-A')).selection).toMatchObject({ pick_types: ['favorite'], cap: 3, used: 1 });

      await setSettings({ max_favorites_per_guest: null });
      await feedback('device-A', photoIds[0], { feedback_type: 'like' });
      await feedback('device-A', photoIds[1], { feedback_type: 'like' });
      expect((await state('device-A')).selection).toMatchObject({ cap: null, used: 2, can_submit: true });
    });

    it('leaves a pick on a photo the guest can no longer see out of the count and the hand-over', async () => {
      await feedback('device-A', photoIds[0], { feedback_type: 'like' });
      await feedback('device-A', photoIds[1], { feedback_type: 'like' });
      await setSettings({ allow_decisions: true });
      await feedback('device-A', photoIds[1], { feedback_type: 'decision', decision: 'rejected' });
      await db('photos').where({ id: photoIds[1] }).update({ visibility: 'hidden' });
      try {
        // What /my-feedback lists, which is what the guest is shown.
        const mine = await as('device-A', 'get', '/my-feedback');
        expect(mine.body.map((row) => row.photo_id)).toEqual([photoIds[0]]);

        const { selection, approval } = await state('device-A');
        expect(selection.used).toBe(1);
        expect(approval.rejected).toBe(0);
        const res = await submit('device-A');
        expect(res.body.submission.item_count).toBe(1);
      } finally {
        await db('photos').where({ id: photoIds[1] }).update({ visibility: 'visible' });
      }
    });

    it('leaves a pick on a photo in the trash out of the count and the hand-over', async () => {
      await feedback('device-A', photoIds[0], { feedback_type: 'like' });
      await feedback('device-A', photoIds[1], { feedback_type: 'like' });
      await db('photos').where({ id: photoIds[1] }).update({
        deleted_at: new Date().toISOString(), purge_after: new Date(Date.now() + 86400000).toISOString(),
      });
      try {
        expect((await state('device-A')).selection.used).toBe(1);
        expect((await submit('device-A')).body.submission.item_count).toBe(1);
      } finally {
        await db('photos').where({ id: photoIds[1] }).update({ deleted_at: null, purge_after: null });
      }
    });

    // An admin retry puts a finished photo back to pending; the gallery list
    // leaves it out until it is complete again, and so do the guest's counts.
    it.each(['pending', 'processing', 'failed'])(
      'leaves a pick on a photo back in %s out of the list, the count and the hand-over, and keeps the row',
      async (status) => {
        await feedback('device-A', photoIds[0], { feedback_type: 'like' });
        await feedback('device-A', photoIds[1], { feedback_type: 'like' });
        await setSettings({ allow_decisions: true });
        await feedback('device-A', photoIds[1], { feedback_type: 'decision', decision: 'rejected' });
        await db('photos').where({ id: photoIds[1] }).update({ processing_status: status });
        try {
          const mine = await as('device-A', 'get', '/my-feedback');
          expect(mine.body.map((row) => row.photo_id)).toEqual([photoIds[0]]);

          const { selection, approval } = await state('device-A');
          expect(selection.used).toBe(1);
          expect(approval.rejected).toBe(0);
          expect((await submit('device-A')).body.submission.item_count).toBe(1);
          expect(await rows('like')).toHaveLength(2);
        } finally {
          await db('photos').where({ id: photoIds[1] }).update({ processing_status: 'complete' });
        }
        // Complete again: the kept rows are back.
        const mine = await as('device-A', 'get', '/my-feedback');
        expect(mine.body.map((row) => row.photo_id).sort()).toEqual([photoIds[0], photoIds[1], photoIds[1]].sort());
        expect((await state('device-A')).selection.used).toBe(2);
      },
    );

    // The photo's own feedback route answers 404 while it is unfinished, so a
    // pick there could not be undone: it must not hold a slot of the cap.
    it.each([['like', 'max_likes_per_guest'], ['favorite', 'max_favorites_per_guest']])(
      'frees the %s slot of a photo back in processing',
      async (type, capColumn) => {
        await setSettings({ [capColumn]: 1, allow_selection_submit: false });
        expect((await feedback('device-A', photoIds[0], { feedback_type: type })).status).toBeLessThan(300);
        expect((await feedback('device-A', photoIds[1], { feedback_type: type })).body.code).toBe(`${type.toUpperCase()}_LIMIT_REACHED`);
        await db('photos').where({ id: photoIds[0] }).update({ processing_status: 'processing' });
        try {
          expect((await state('device-A')).selection.used).toBe(0);
          expect((await feedback('device-A', photoIds[1], { feedback_type: type })).status).toBeLessThan(300);
          expect(await rows(type)).toHaveLength(2);
        } finally {
          await db('photos').where({ id: photoIds[0] }).update({ processing_status: 'complete' });
        }
        // Complete again: over the cap, so a new pick is refused until one goes.
        expect((await feedback('device-A', photoIds[2], { feedback_type: type })).status).toBe(403);
      },
    );

    it('is off without a cap and without the switch', async () => {
      await setSettings({ allow_selection_submit: false });
      expect((await state('device-A')).selection).toMatchObject({ counter: false, can_submit: false });
      expect((await submit('device-A')).status).toBe(403);
    });
  });

  describe('submitting a selection', () => {
    beforeEach(async () => {
      await feedback('device-A', photoIds[0], { feedback_type: 'like', guest_name: 'Anna' });
      await feedback('device-A', photoIds[1], { feedback_type: 'favorite' });
    });

    it('stores it, shows it to that guest and refuses a second one', async () => {
      const res = await submit('device-A', { kind: 'selection', note: 'Album, please' });
      expect(res.status).toBe(201);
      expect(res.body.submission).toMatchObject({ kind: 'selection', item_count: 2, note: 'Album, please' });
      expect(res.body.submission.submitted_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

      expect((await state('device-A')).selection.submission).toMatchObject({ item_count: 2 });

      const again = await submit('device-A');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_SUBMITTED');
      expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(1);
    });

    it('refuses an empty selection, an unknown kind and an over-long note', async () => {
      const empty = await submit('device-B');
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe('NOTHING_SELECTED');
      expect((await submit('device-A', { kind: 'order' })).status).toBe(400);
      expect((await submit('device-A', { kind: 'selection', note: 'x'.repeat(1001) })).status).toBe(400);
      expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(0);
    });

    it('locks likes and favourites on the server, adds and removals alike', async () => {
      await submit('device-A');

      const add = await feedback('device-A', photoIds[2], { feedback_type: 'like' });
      expect(add.status).toBe(409);
      expect(add.body).toMatchObject({ code: 'SELECTION_LOCKED', kind: 'selection' });
      const remove = await feedback('device-A', photoIds[0], { feedback_type: 'like' });
      expect(remove.status).toBe(409);
      const favorite = await feedback('device-A', photoIds[2], { feedback_type: 'favorite' });
      expect(favorite.status).toBe(409);

      expect(await rows('like')).toHaveLength(1);
      expect(await rows('favorite')).toHaveLength(1);
    });

    // A like or an un-like racing the hand-over must land wholly before it
    // (and be counted) or be refused: the count the photographer is told is
    // the picks that are there afterwards. Service level, so the two start
    // in a known order.
    it.each([
      ['an added like, started first', 'add', false],
      ['an added like, started second', 'add', true],
      ['a removed like, started first', 'remove', false],
      ['a removed like, started second', 'remove', true],
    ])('keeps the stored count equal to the picks when it overlaps %s', async (_name, change, submitFirst) => {
      const selectionSubmissions = require('../../src/services/selectionSubmissions');
      const viewer = { guestId: null, guestIdentifier: 'race-device' };
      const like = (photoId) => feedbackService.submitFeedback(
        photoId, eventId, { feedback_type: 'like', guest_id: null }, viewer.guestIdentifier,
      );
      await like(photoIds[0]);
      await like(photoIds[1]);
      const settings = await feedbackService.getEventFeedbackSettings(eventId);

      const write = () => like(change === 'add' ? photoIds[2] : photoIds[1]);
      const handIn = () => selectionSubmissions.submit(eventId, settings, viewer, { kind: 'selection' });
      const [written, handedIn] = submitFirst
        ? (await Promise.all([handIn(), write()])).reverse()
        : await Promise.all([write(), handIn()]);

      const picks = await db('photo_feedback')
        .where({ event_id: eventId, guest_identifier: viewer.guestIdentifier, feedback_type: 'like' });
      expect(handedIn.submission.item_count).toBe(picks.length);
      // Either the write went in first, or it met the lock.
      expect(picks.length).toBe(written.locked ? 2 : (change === 'add' ? 3 : 1));
      // The tiles' counters followed the write, or the refusal (every
      // guest's likes: device-A has one from the setup above).
      const counted = await db('photos').whereIn('id', photoIds).sum('like_count as likes').first();
      expect(Number(counted.likes)).toBe((await rows('like')).length);
    });

    it('leaves ratings, colour labels and comments writable', async () => {
      await submit('device-A');
      expect((await feedback('device-A', photoIds[0], { feedback_type: 'rating', rating: 4 })).status).toBe(200);
      expect((await feedback('device-A', photoIds[0], { feedback_type: 'color_label', color_label: 'green' })).status).toBe(200);
      expect((await feedback('device-A', photoIds[0], { feedback_type: 'comment', comment_text: 'Lovely', guest_name: 'Anna' })).status).toBe(200);
      expect(await rows('rating')).toHaveLength(1);
      expect(await rows('color_label')).toHaveLength(1);
      expect(await rows('comment')).toHaveLength(1);
    });

    it('is per guest: another guest neither sees nor is bound by it', async () => {
      await submit('device-A');

      expect((await state('device-B')).selection).toMatchObject({ used: 0, submission: null });
      expect((await feedback('device-B', photoIds[2], { feedback_type: 'like' })).status).toBe(200);
      const own = await submit('device-B');
      expect(own.status).toBe(201);
      expect(own.body.submission.item_count).toBe(1);
      // A's is untouched by B's.
      expect((await state('device-A')).selection.submission).toMatchObject({ item_count: 2 });
      expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(2);
    });

    it('tells the photographer: activity, webhook and a mail that is due at once', async () => {
      await db('webhooks').insert({
        name: 'selection', url: 'https://example.com/hook', secret: 'whsec_test', secret_preview: 'test',
        events: JSON.stringify(['selection.submitted']), active: true, created_by: adminId,
      });
      await submit('device-A', { kind: 'selection', note: 'Album' });

      const activity = await db('activity_logs').where({ event_id: eventId, activity_type: 'selection_submitted' }).first();
      expect(JSON.parse(activity.metadata)).toMatchObject({ kind: 'selection', guestName: 'Anna', count: 2 });
      expect(activity.actor_type).toBe('guest');

      const delivery = await db('webhook_deliveries').where({ event_type: 'selection.submitted' }).first();
      const payload = JSON.parse(delivery.payload);
      expect(payload.type).toBe('selection.submitted');
      expect(payload.data.event).toMatchObject({ id: eventId, slug: SLUG });
      expect(payload.data.submission).toMatchObject({ kind: 'selection', guest_name: 'Anna', count: 2, note: 'Album' });

      const mail = await db('email_queue').where({ event_id: eventId, email_type: 'selection_submitted' }).first();
      expect(mail.recipient_email).toBe('studio@example.com');
      // NULL, never the column default: text never comes due on SQLite.
      expect(mail.scheduled_at).toBeNull();
      expect(JSON.parse(mail.email_data)).toMatchObject({ item_count: '2', is_selection: 'yes', is_approval: '', guest_name: 'Anna' });
    });

    it('ships a template for that mail in both seeded languages', () => {
      const { GALLERY_DELIVERY_TEMPLATES } = require('../../src/services/galleryDeliveryTemplates');
      for (const language of ['en', 'de']) {
        const { subject, body_html: html, body_text: text } = GALLERY_DELIVERY_TEMPLATES.selection_submitted[language];
        // The processor's {{#if}} does not nest.
        for (const part of [subject, html, text]) {
          expect(part).not.toMatch(/\{\{#if[^}]*\}\}(?:(?!\{\{\/if\}\})[\s\S])*\{\{#if/);
          expect(part.match(/\{\{#if/g).length).toBe(part.match(/\{\{\/if\}\}/g).length);
        }
      }
    });

    it('an admin lists the submissions and reopens one, which unlocks the picks', async () => {
      await submit('device-A');
      const list = await admin('get', '/selection-submissions');
      expect(list.status).toBe(200);
      expect(list.body.submissions).toEqual([
        expect.objectContaining({ kind: 'selection', item_count: 2, guest_name: 'Anna', reopened_at: null }),
      ]);
      const { id } = list.body.submissions[0];

      const reopened = await admin('post', `/selection-submissions/${id}/reopen`);
      expect(reopened.status).toBe(200);
      expect((await admin('post', `/selection-submissions/${id}/reopen`)).status).toBe(404);
      expect(await db('selection_submissions').where({ id }).first()).toMatchObject({ reopened_by: adminId });
      expect(await db('activity_logs').where({ event_id: eventId, activity_type: 'selection_reopened' })).toHaveLength(1);

      expect((await state('device-A')).selection.submission).toBeNull();
      expect((await feedback('device-A', photoIds[2], { feedback_type: 'like' })).status).toBe(200);
      // And the guest can hand it in again; the first row stays as history.
      const second = await submit('device-A');
      expect(second.status).toBe(201);
      expect(second.body.submission.item_count).toBe(3);
      expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(2);
    });

    it('does not reopen through another gallery, and needs an admin', async () => {
      await submit('device-A');
      const { id } = await db('selection_submissions').where({ event_id: eventId }).first();
      const other = await request(app)
        .post(`/api/admin/feedback/events/${eventId + 1000}/selection-submissions/${id}/reopen`)
        .set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
      expect(other.status).toBe(404);
      const anonymous = await request(app).post(`/api/admin/feedback/events/${eventId}/selection-submissions/${id}/reopen`);
      expect(anonymous.status).toBe(401);
      expect((await db('selection_submissions').where({ id }).first()).reopened_at).toBeNull();
    });
  });

  describe('approving the edited photos', () => {
    beforeEach(() => setSettings({ allow_decisions: true }));

    it('is only offered while approve / reject is on', async () => {
      await setSettings({ allow_decisions: false });
      expect((await state('device-A')).approval.can_submit).toBe(false);
      const res = await submit('device-A', { kind: 'approval' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SUBMISSION_DISABLED');
    });

    it('locks that guest\'s decisions and nothing else, beside a selection of its own', async () => {
      await feedback('device-A', photoIds[0], { feedback_type: 'decision', decision: 'approved' });
      await feedback('device-A', photoIds[1], { feedback_type: 'decision', decision: 'rejected', comment_text: 'Blurry' });
      expect((await state('device-A')).approval).toMatchObject({ can_submit: true, approved: 1, rejected: 1, submission: null });

      const res = await submit('device-A', { kind: 'approval' });
      expect(res.status).toBe(201);
      expect(res.body.submission).toMatchObject({ kind: 'approval', item_count: 1 });

      const locked = await feedback('device-A', photoIds[2], { feedback_type: 'decision', decision: 'approved' });
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe('APPROVAL_LOCKED');
      expect(await rows('decision')).toHaveLength(2);

      // The picks are a separate submission: still open, and can be handed in.
      expect((await feedback('device-A', photoIds[0], { feedback_type: 'like' })).status).toBe(200);
      expect((await submit('device-A', { kind: 'selection' })).status).toBe(201);
      expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(2);

      const activity = await db('activity_logs').where({ event_id: eventId, activity_type: 'approval_submitted' }).first();
      expect(JSON.parse(activity.metadata)).toMatchObject({ kind: 'approval', count: 1 });
      const mail = await db('email_queue').where({ event_id: eventId, email_type: 'selection_submitted' }).first();
      expect(JSON.parse(mail.email_data)).toMatchObject({ is_approval: 'yes', is_selection: '', rejected_count: '1' });
    });

    it('an approval needs no per-photo decision', async () => {
      const res = await submit('device-A', { kind: 'approval' });
      expect(res.status).toBe(201);
      expect(res.body.submission.item_count).toBe(0);
    });

    // Issue 1984: an approval needs no feedback, so no name prompt ran first.
    describe('in a gallery that requires name and email', () => {
      beforeEach(() => setSettings({ require_name_email: true }));

      it('refuses an anonymous approval, in simple and in shared mode', async () => {
        for (const mode of ['simple', 'shared']) {
          await setSettings({ identity_mode: mode });
          const res = await submit('device-A', { kind: 'approval' });
          expect(res.status).toBe(400);
          expect(res.body.code).toBe('GUEST_INFO_REQUIRED');
          const partial = await submit('device-A', { kind: 'approval', guest_name: 'Clara' });
          expect(partial.status).toBe(400);
          expect(partial.body.code).toBe('GUEST_INFO_REQUIRED');
        }
        expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(0);
      });

      it('stores an approval with the name and email the dialog asked for', async () => {
        const res = await submit('device-A', { kind: 'approval', guest_name: ' Clara ', guest_email: 'clara@example.com' });
        expect(res.status).toBe(201);
        const row = await db('selection_submissions').where({ event_id: eventId }).first();
        expect(row.guest_name).toBe('Clara');
      });

      it('stores an accented name in its NFC form, as the feedback routes do', async () => {
        const res = await submit('device-A', { kind: 'approval', guest_name: ' Jo\u0308rg ', guest_email: 'clara@example.com' });
        expect(res.status).toBe(201);
        const row = await db('selection_submissions').where({ event_id: eventId }).first();
        expect(row.guest_name).toBe('J\u00F6rg');
      });

      it('refuses a name the feedback routes refuse', async () => {
        for (const guest_name of ['<Alice>', 'A'.repeat(101)]) {
          const res = await submit('device-A', { kind: 'approval', guest_name, guest_email: 'clara@example.com' });
          expect(res.status).toBe(400);
          expect(res.body.errors[0].path).toBe('guest_name');
        }
        expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(0);
      });

      it('names a guest by their earlier feedback, so a selection still goes through', async () => {
        await feedback('device-A', photoIds[0], {
          feedback_type: 'like', guest_name: 'Dora', guest_email: 'dora@example.com',
        });
        expect((await submit('device-A', { kind: 'selection' })).status).toBe(201);
        expect((await submit('device-A', { kind: 'approval' })).status).toBe(201);
        const names = await db('selection_submissions').where({ event_id: eventId }).pluck('guest_name');
        expect(Array.from(names)).toEqual(['Dora', 'Dora']);
      });

      it('does not take a name given without an email, or blank, while both were optional', async () => {
        await setSettings({ require_name_email: false });
        expect((await feedback('device-A', photoIds[0], { feedback_type: 'like', guest_name: 'Dora' })).status)
          .toBeLessThan(300);
        expect((await feedback('device-A', photoIds[1], {
          feedback_type: 'like', guest_name: 'Dora', guest_email: '   ',
        })).status).toBeLessThan(300);
        expect((await feedback('device-A', photoIds[2], {
          feedback_type: 'like', guest_name: '   ', guest_email: 'dora@example.com',
        })).status).toBeLessThan(300);
        await setSettings({ require_name_email: true });
        const res = await submit('device-A', { kind: 'approval' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('GUEST_INFO_REQUIRED');
        expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(0);
      });

      it('does not take a tab-only earlier name or email either', async () => {
        await setSettings({ require_name_email: false });
        await feedback('device-A', photoIds[0], { feedback_type: 'like', guest_name: 'Dora', guest_email: '\t' });
        await feedback('device-A', photoIds[1], { feedback_type: 'like', guest_name: '\n', guest_email: 'dora@example.com' });
        expect(await rows('like')).toHaveLength(2);
        await setSettings({ require_name_email: true });
        const res = await submit('device-A', { kind: 'approval' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('GUEST_INFO_REQUIRED');
      });

      it('finds a usable earlier name behind more than a page of blank ones', async () => {
        const selectionSubmissions = require('../../src/services/selectionSubmissions');
        const [anna] = guests;
        const row = (guest_email) => ({
          event_id: eventId, photo_id: photoIds[0], feedback_type: 'comment', comment_text: 'x',
          guest_id: anna.id, guest_identifier: anna.identifier, guest_name: 'Anna', guest_email,
        });
        await db('photo_feedback').insert(row('anna@example.com'));
        for (let i = 0; i < selectionSubmissions.FEEDBACK_NAME_PAGE + 5; i += 1) {
          await db('photo_feedback').insert(row(' '));
        }
        const viewer = { guestId: anna.id, guestIdentifier: anna.identifier };
        expect(await selectionSubmissions.feedbackName(eventId, viewer, { requireEmail: true })).toBe('Anna');
        await db('photo_feedback').where({ guest_email: 'anna@example.com' }).delete();
        expect(await selectionSubmissions.feedbackName(eventId, viewer, { requireEmail: true })).toBeNull();
      });

      it('outside guest mode, takes a kept guest token only when it carries an email', async () => {
        const [anna, ben] = guests;
        await db('gallery_guests').where({ id: anna.id }).update({ email: null });
        const refused = await submit(anna, { kind: 'approval' });
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('GUEST_INFO_REQUIRED');
        const typed = await submit(anna, { kind: 'approval', guest_name: 'Anna', guest_email: 'anna@example.com' });
        expect(typed.status).toBe(201);
        expect((await submit(ben, { kind: 'approval' })).status).toBe(201);
      });

      it('leaves registered guests to their token', async () => {
        await setSettings({ identity_mode: 'guest' });
        const res = await submit(guests[0], { kind: 'approval' });
        expect(res.status).toBe(201);
      });
    });

    it('still takes an anonymous approval where name and email are optional', async () => {
      await setSettings({ require_name_email: false });
      expect((await submit('device-A', { kind: 'approval' })).status).toBe(201);
    });
  });

  describe('registered guests', () => {
    beforeEach(() => setSettings({ identity_mode: 'guest' }));

    it('needs the guest identity to submit', async () => {
      const res = await submit('device-A');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('GUEST_IDENTITY_REQUIRED');
    });

    it('refuses a guest who was deleted after the request was let in', async () => {
      const selectionSubmissions = require('../../src/services/selectionSubmissions');
      await setSettings({ allow_decisions: true });
      const settings = await feedbackService.getEventFeedbackSettings(eventId);
      const [anna] = guests;
      await db('gallery_guests').where({ id: anna.id }).update({ is_deleted: true });

      // An approval needs no decision, so nothing else would stop it.
      const result = await selectionSubmissions.submit(
        eventId, settings, { guestId: anna.id, guestIdentifier: anna.identifier }, { kind: 'approval' },
      );
      expect(result).toEqual({ guest_missing: true });
      expect(await db('selection_submissions').where({ event_id: eventId })).toHaveLength(0);
    });

    it('keeps one guest\'s submission from another', async () => {
      const [anna, ben] = guests;
      await feedback(anna, photoIds[0], { feedback_type: 'like' });
      await feedback(ben, photoIds[1], { feedback_type: 'like' });
      expect((await submit(anna)).status).toBe(201);

      expect((await state(ben)).selection).toMatchObject({ used: 1, submission: null });
      expect((await feedback(ben, photoIds[2], { feedback_type: 'like' })).status).toBe(200);
      expect((await feedback(anna, photoIds[2], { feedback_type: 'like' })).status).toBe(409);

      const stored = await db('selection_submissions').where({ event_id: eventId }).first();
      expect(stored).toMatchObject({ guest_id: anna.id, guest_identifier: anna.identifier, guest_name: 'anna' });
    });

    it('a merge carries the submission to the surviving guest', async () => {
      const [anna, ben] = guests;
      await feedback(ben, photoIds[0], { feedback_type: 'like' });
      expect((await submit(ben)).status).toBe(201);

      await feedbackService.mergeGuestFeedback(anna.id, [ben.id]);

      expect(await db('selection_submissions').where({ event_id: eventId })).toEqual([
        expect.objectContaining({ guest_id: anna.id, guest_identifier: anna.identifier, kind: 'selection' }),
      ]);
      expect((await state(anna)).selection.submission).toMatchObject({ item_count: 1 });
      expect((await feedback(anna, photoIds[1], { feedback_type: 'like' })).status).toBe(409);
    });

    it('a merge of two guests who both submitted keeps the latest one', async () => {
      const [anna, ben] = guests;
      await feedback(anna, photoIds[0], { feedback_type: 'like' });
      await feedback(ben, photoIds[1], { feedback_type: 'like' });
      await submit(anna);
      const later = (await submit(ben)).body.submission.id;

      await feedbackService.mergeGuestFeedback(anna.id, [ben.id]);

      const left = await db('selection_submissions').where({ event_id: eventId });
      expect(left.map((row) => row.id)).toEqual([later]);
      expect(left[0]).toMatchObject({ guest_id: anna.id, guest_identifier: anna.identifier });
    });

    it('"forget me" leaves no name on a hand-over that slipped in before the delete', async () => {
      const selectionSubmissions = require('../../src/services/selectionSubmissions');
      await setSettings({ allow_decisions: true });
      const settings = await feedbackService.getEventFeedbackSettings(eventId);
      const [anna] = guests;
      // The approval queued behind the anonymisation, ahead of the delete.
      const anonymize = feedbackService.anonymizeGuestFeedback.bind(feedbackService);
      const spy = jest.spyOn(feedbackService, 'anonymizeGuestFeedback').mockImplementation(async (id) => {
        const result = await anonymize(id);
        const late = await selectionSubmissions.submit(
          eventId, settings, { guestId: anna.id, guestIdentifier: anna.identifier }, { kind: 'approval', guestName: 'anna' },
        );
        expect(late.submission).toBeTruthy();
        return result;
      });
      try {
        expect((await as(anna, 'delete', '/guest/me')).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      expect(await db('selection_submissions').where({ event_id: eventId }).first())
        .toMatchObject({ kind: 'approval', guest_id: null, guest_name: null });
    });

    it('a deleted guest cannot take a pick back either', async () => {
      const [anna] = guests;
      await feedback(anna, photoIds[0], { feedback_type: 'like' });
      await db('gallery_guests').where({ id: anna.id }).update({ is_deleted: true });
      const result = await feedbackService.submitFeedback(
        photoIds[0], eventId, { feedback_type: 'like', guest_id: anna.id }, anna.identifier,
      );
      expect(result).toEqual({ guest_missing: true });
      expect(await rows('like')).toHaveLength(1);
    });

    it('forgetting a guest keeps the submission without the person', async () => {
      const [anna] = guests;
      await feedback(anna, photoIds[0], { feedback_type: 'like' });
      await submit(anna);
      await feedbackService.anonymizeGuestFeedback(anna.id);
      expect(await db('selection_submissions').where({ event_id: eventId }).first())
        .toMatchObject({ guest_id: null, guest_name: null, item_count: 1 });
    });
  });

  it('is removed with the gallery on SQLite, where the FK cascade is inert', async () => {
    const source = require('fs').readFileSync(require.resolve('../../src/routes/adminEvents/helpers'), 'utf8');
    expect(source).toMatch(/trx\('selection_submissions'\)\.where\('event_id', eventId\)\.del\(\)/);
  });
});
