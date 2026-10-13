/**
 * "Finish selection" under real concurrency (issue 1733, A1), on PostgreSQL.
 *
 * SQLite runs one transaction at a time, so these two interleavings cannot
 * happen there at all. On PostgreSQL the viewer lock is per guest, which
 * leaves two things to other mechanisms:
 *
 * - two guests liking one photo run side by side, so the photo's counters
 *   are rebuilt after the commit, not inside the transaction;
 * - a guest merge does not take the viewer lock, so a locked write holds the
 *   guest row FOR SHARE and the merge waits for it.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const request = require('supertest');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

(pgUrl ? describe : describe.skip)('selection submissions under concurrency (pg)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let feedbackService; let selectionSubmissions; let helpers;
  let adminId; let eventId; let photoIds;

  beforeAll(async () => {
    schema = `selection_race_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'selection-race-pg-test-secret-at-least-32-characters';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-selection-pg-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
    ({ db } = require('../../src/database/db'));
    helpers = require('./helpers/crmDb');
    ({ cleanup } = await helpers.bootCrmDb());
    ({ adminId } = await helpers.seedMinimal(db));
    await helpers.assignAdminRole(db, adminId);
    feedbackService = require('../../src/services/feedbackService');
    selectionSubmissions = require('../../src/services/selectionSubmissions');

    const [event] = await db('events').insert({
      slug: 'selection-race',
      event_type: 'wedding',
      event_name: 'Selection Race',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'studio@example.com',
      password_hash: 'x',
      share_link: '/gallery/selection-race/share',
      share_token: 'selection-race-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: true, is_archived: false, is_draft: false,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = event.id;
    const photos = await db('photos').insert([1, 2, 3].map((n) => ({
      event_id: eventId, filename: `p${n}.jpg`, path: `events/selection-race/p${n}.jpg`,
      type: 'individual', uploaded_at: new Date().toISOString(),
    }))).returning('id');
    photoIds = photos.map((row) => row.id);
    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, allow_likes: true, allow_selection_submit: true,
    });
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  afterEach(() => jest.restoreAllMocks());

  it('counts both likes when two guests like one photo in overlapping transactions', async () => {
    const write = feedbackService.writeGuestFeedback.bind(feedbackService);
    let written = 0;
    let open;
    const bothWritten = new Promise((resolve) => { open = resolve; });
    // Each transaction stays open until the other guest's row is in as well:
    // neither can see the other's like before it commits.
    jest.spyOn(feedbackService, 'writeGuestFeedback').mockImplementation(async (...args) => {
      try {
        return await write(...args);
      } finally {
        written += 1;
        if (written === 2) open();
        await bothWritten;
      }
    });

    const like = (identifier) => feedbackService.submitFeedback(
      photoIds[0], eventId, { feedback_type: 'like', guest_id: null }, identifier,
    );
    const results = await Promise.all([like('race-guest-a'), like('race-guest-b')]);

    expect(results).toEqual([
      expect.objectContaining({ created: true }),
      expect.objectContaining({ created: true }),
    ]);
    expect(await db('photo_feedback').where({ photo_id: photoIds[0], feedback_type: 'like' })).toHaveLength(2);
    expect((await db('photos').where({ id: photoIds[0] }).first()).like_count).toBe(2);
  });

  it('a merge that hands the guest a finished selection waits for their like in flight', async () => {
    const [anna, ben] = await db('gallery_guests').insert(['anna', 'ben'].map((name) => ({
      event_id: eventId, name, identifier: `guest-${name}`, email: `${name}@example.com`, is_deleted: false,
    }))).returning('*');
    const viewer = (guest) => ({ guestId: guest.id, guestIdentifier: guest.identifier });
    const like = (guest, photoId) => feedbackService.submitFeedback(
      photoId, eventId, { feedback_type: 'like', guest_id: guest.id, guest_name: guest.name }, guest.identifier,
    );

    // Ben finished his selection; Anna has not.
    expect(await like(ben, photoIds[1])).toMatchObject({ created: true });
    const settings = await feedbackService.getEventFeedbackSettings(eventId);
    const handedIn = await selectionSubmissions.submit(eventId, settings, viewer(ben), { kind: 'selection', guestName: 'ben' });
    expect(handedIn.submission).toMatchObject({ kind: 'selection', item_count: 1 });

    const app = helpers.buildRouteApp('/api/admin', require('../../src/routes/adminGuests'));
    let merge;
    let mergeAnswered = false;
    let answeredWhileWriting = null;
    const lockFor = selectionSubmissions.lockFor;
    // Anna's like is past the guest-row read and about to check the lock:
    // the merge of Ben into Anna starts now, and has to wait for her.
    jest.spyOn(selectionSubmissions, 'lockFor').mockImplementationOnce(async (...args) => {
      merge = request(app)
        .post(`/api/admin/events/${eventId}/guests/${anna.id}/merge`)
        .set('Authorization', `Bearer ${helpers.mintAdminToken(adminId)}`)
        .send({ mergeIds: [ben.id] })
        .then((res) => { mergeAnswered = true; return res; });
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      answeredWhileWriting = mergeAnswered;
      return lockFor(...args);
    });

    const liked = await like(anna, photoIds[2]);
    const merged = await merge;

    expect(answeredWhileWriting).toBe(false);
    expect(liked).toMatchObject({ created: true });
    expect(merged.status).toBe(200);
    // The selection is Anna's now, with the like that went in before it moved.
    expect(await db('selection_submissions').where({ event_id: eventId }).whereNull('reopened_at'))
      .toEqual([expect.objectContaining({ guest_id: anna.id, kind: 'selection' })]);
    expect(await like(anna, photoIds[0])).toMatchObject({ locked: true, kind: 'selection' });
    expect(await db('photo_feedback').where({ event_id: eventId, guest_id: anna.id, feedback_type: 'like' })).toHaveLength(2);
  });
});
