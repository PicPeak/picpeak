/**
 * PostgreSQL tests for the photo trash (issue 1733, migration 294).
 * Gated: runs only when PICPEAK_PG_TEST_URL points at a throwaway Postgres
 * database (the `backend` CI job provides one). Works in a schema of its own
 * and drops it.
 *
 * The SQLite suite (photoTrash.test.js) has one writer and cannot show:
 *  - the pending claim: of several replicas trashing one photo at once, the
 *    partial unique index lets exactly one in and the others are told the
 *    photo is busy
 *  - the lock order: a restore takes the event row before its trash row, as
 *    deleting a gallery does, so the two wait for each other instead of
 *    deadlocking
 *  - a snapshot taken on SQLite (epoch numbers for timestamps) going into
 *    PostgreSQL's timestamp columns, and the id sequence moving past a
 *    restored id
 */
const knex = require('knex');
const crypto = require('crypto');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const pg = pgUrl ? describe : describe.skip;

pg('photo trash on PostgreSQL', () => {
  let owner; let db; let other; let schema; let photoTrash; let eventId;
  const now = () => new Date().toISOString();
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pending = (photoId, extra = {}) => ({
    photo_id: photoId, event_id: eventId, state: 'pending', state_changed_at: now(), filename: `IMG_${photoId}.jpg`,
    deleted_at: now(), purge_after: now(), photo_row: '{}', children: '{}', ...extra,
  });

  beforeAll(async () => {
    schema = `photo_trash_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 8 } });
    other = knex({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 4 } });
    jest.doMock('../../src/database/db', () => ({ db }));
    await db.schema.createTable('events', (t) => { t.increments('id'); t.string('slug'); t.integer('hero_photo_id'); });
    await db.schema.createTable('photos', (t) => {
      t.increments('id'); t.integer('event_id'); t.string('filename'); t.string('path');
      t.timestamp('uploaded_at'); t.string('processing_status'); t.string('moderation_status');
      // What a restore always writes, checked against what still exists.
      t.integer('category_id'); t.integer('folder_id'); t.integer('uploaded_by_admin_id');
    });
    const migration = require('../../migrations/core/294_photo_trash');
    await migration.up(db);
    // Safe to re-run.
    await migration.up(db);
    photoTrash = require('../../src/services/photoTrashService');
    [{ id: eventId }] = await db('events').insert({ slug: 'pg-trash' }).returning('id');
  });

  afterAll(async () => {
    if (other) await other.destroy();
    if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
  });

  beforeEach(async () => { await db('photo_trash').del(); await db('photos').del(); });

  test('the partial unique index allows one pending row per photo, and any number at rest', async () => {
    await db('photo_trash').insert(pending(1));
    await expect(db('photo_trash').insert(pending(1))).rejects.toMatchObject({ code: '23505' });
    await db('photo_trash').insert(pending(1, { state: 'trashed' }));
    await db('photo_trash').insert(pending(1, { state: 'trashed' }));
    await db('photo_trash').insert(pending(2));
  });

  test('of replicas claiming one photo at once, one gets the claim and the rest are told it is busy', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => photoTrash._internal.claimPending(pending(7)))
    );
    const won = results.filter((result) => result.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect(won[0].value.row.id).toEqual(expect.any(Number));
    for (const lost of results.filter((result) => result.status === 'rejected')) {
      expect(lost.reason).toMatchObject({ code: 'TRASH_BUSY', statusCode: 409 });
    }
    expect(await db('photo_trash').where({ photo_id: 7 })).toHaveLength(1);
  });

  /** A trash entry claimed for a restore, as restorePhoto has it before its transaction. */
  async function claimedRestore(photoId, photoRow = {}) {
    const stamp = now();
    const [{ id }] = await db('photo_trash').insert(pending(photoId, {
      state: 'restoring', state_changed_at: stamp,
      photo_row: JSON.stringify({ id: photoId, event_id: eventId, filename: `IMG_${photoId}.jpg`, path: `pg-trash/IMG_${photoId}.jpg`, ...photoRow }),
    })).returning('id');
    return { id, photo_id: photoId, event_id: eventId, state: 'restoring', state_changed_at: stamp };
  }
  const restoreInTransaction = async (claim) => {
    const columns = new Set(Object.keys(await db('photos').columnInfo()));
    const forEngine = await photoTrash.snapshotCoercion();
    return db.transaction((trx) => photoTrash._internal.insertRestored(trx, { id: eventId, slug: 'pg-trash' }, claim, columns, forEngine));
  };
  /** Holds the event row FOR UPDATE in another session, as deleteEventCascade does first. */
  function holdEvent(whileHeld = async () => {}) {
    let release; let locked;
    const held = new Promise((resolve) => { release = resolve; });
    const hasLock = new Promise((resolve) => { locked = resolve; });
    const done = other.transaction(async (trx) => {
      await trx('events').where({ id: eventId }).forUpdate().first();
      locked();
      await held;
      await whileHeld(trx);
    });
    return { hasLock, release, done };
  }

  test('a restore takes the event row before its trash row', async () => {
    const claim = await claimedRestore(21);
    const holder = holdEvent();
    await holder.hasLock;

    let settled = false;
    const restoring = restoreInTransaction(claim).finally(() => { settled = true; });
    await tick(400);
    expect(settled).toBe(false);
    // Waiting on the event, it holds nothing yet: the trash row can be locked by someone else.
    await other.transaction((trx) => trx.raw('SELECT id FROM photo_trash WHERE id = ? FOR UPDATE NOWAIT', [claim.id]));

    holder.release();
    await holder.done;
    await expect(restoring).resolves.toBe(21);
    expect(await db('photo_trash').where({ id: claim.id }).first()).toBeUndefined();
    expect(await db('photos').where({ id: 21 }).first()).toMatchObject({ event_id: eventId, filename: 'IMG_21.jpg' });
  });

  test('a gallery delete and a restore do not deadlock: the restore waits and finds its claim gone', async () => {
    const claim = await claimedRestore(22);
    // Event first, then the trash rows: the order deleteEventCascade uses.
    const holder = holdEvent((trx) => trx('photo_trash').where({ event_id: eventId }).del());
    await holder.hasLock;
    const restoring = restoreInTransaction(claim);
    await tick(300);
    holder.release();
    await holder.done;
    await expect(restoring).rejects.toMatchObject({ code: 'TRASH_BUSY' });
    expect(await db('photos').where({ id: 22 }).first()).toBeUndefined();
  });

  test('restores a SQLite snapshot: epoch timestamps are stored as that instant, and the sequence moves past the id', async () => {
    const at = Date.parse('2026-03-04T05:06:07.000Z');
    const claim = await claimedRestore(500, { uploaded_at: at });
    await expect(restoreInTransaction(claim)).resolves.toBe(500);
    const restored = await db('photos').where({ id: 500 }).first();
    expect(new Date(restored.uploaded_at).getTime()).toBe(at);
    expect(restored.restored_from_trash_at).toEqual(expect.any(String));
    const [{ id: next }] = await db('photos').insert({ event_id: eventId, filename: 'next.jpg' }).returning('id');
    expect(next).toBeGreaterThan(500);
  });
});
