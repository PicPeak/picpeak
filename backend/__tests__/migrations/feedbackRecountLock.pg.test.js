/**
 * Issue 2564: a recount read the aggregates before taking any lock, so on
 * PostgreSQL a recount racing another writer on the same photo could count
 * that writer's uncommitted change, wait for it on its UPDATE, and land last
 * with a stale like_count. updatePhotoFeedbackStats now locks the photo row
 * first, so the waiting recount reads after the other writer committed.
 *
 * Runs only with PICPEAK_PG_TEST_URL (CI sets it); SQLite serialises writers.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
(pgUrl ? describe : describe.skip)('feedback recount lock on PostgreSQL (issue 2564)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let feedbackService; let eventId; let photoId;

  beforeAll(async () => {
    schema = `recount_lock_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'recount-lock-test-secret-at-least-32-characters';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-recount-lock-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 4 } }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('../integration/helpers/crmDb').bootCrmDb());
    feedbackService = require('../../src/services/feedbackService');

    const [ev] = await db('events').insert({
      slug: 'recount-lock', event_type: 'wedding', event_name: 'Recount lock', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/recount-lock/share', share_token: 'recount-lock-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: true, is_archived: false, is_draft: false, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev.id ?? ev;
    const [photo] = await db('photos').insert({
      event_id: eventId, filename: 'a.jpg', path: 'events/recount/a.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = photo.id ?? photo;
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  const like = async (guest) => {
    const [row] = await db('photo_feedback').insert({
      photo_id: photoId, event_id: eventId, feedback_type: 'like', guest_identifier: guest,
      is_hidden: false, is_approved: true, created_at: new Date().toISOString(),
    }).returning('id');
    return row.id ?? row;
  };

  // Some statement of another connection is waiting for a lock.
  const someoneWaits = async () => {
    const { rows } = await owner.raw('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted');
    return rows[0].n > 0;
  };

  it('a recount racing an uncommitted change counts it only after the commit', async () => {
    const likeA = await like('guest-a');
    const likeB = await like('guest-b');
    await feedbackService.updatePhotoFeedbackStats(photoId);
    expect(Number((await db('photos').where({ id: photoId }).first()).like_count)).toBe(2);

    // Writer A (say a bulk removal) deletes its like and recounts inside its
    // transaction, and has not committed yet.
    const trxA = await db.transaction();
    await trxA('photo_feedback').where({ id: likeA }).del();
    await feedbackService.updatePhotoFeedbackStats(photoId, trxA);

    // Writer B takes back its own like and recounts on its own.
    await db('photo_feedback').where({ id: likeB }).del();
    const recountB = feedbackService.updatePhotoFeedbackStats(photoId);

    // B is blocked on the photo row either way: on the lock taken before its
    // read (fixed) or on its UPDATE after a read that still saw A's like.
    const deadline = Date.now() + 10000;
    while (!(await someoneWaits())) {
      if (Date.now() > deadline) throw new Error('recount B never waited for A');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await trxA.commit();
    await recountB;

    expect(await db('photo_feedback').where({ photo_id: photoId, feedback_type: 'like' })).toHaveLength(0);
    expect(Number((await db('photos').where({ id: photoId }).first()).like_count)).toBe(0);
  }, 60000);
});
