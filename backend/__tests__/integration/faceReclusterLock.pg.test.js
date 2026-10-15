/**
 * Re-grouping people against a face scan of the same event, on PostgreSQL
 * (issue 2112).
 *
 * recluster() cleared the event's people in one transaction and re-assigned
 * them without one, so assignFaces took the in-process lock but never the
 * event's advisory lock, pg_advisory_xact_lock(1074, event). It now runs as
 * one transaction under the advisory lock (and never holds the in-process
 * mutex while it waits in PostgreSQL), so it waits for a scan that holds the
 * lock, a scan waits for it, and both finish.
 *
 * The scan here is the clustering half of processPhotoFaces: a transaction
 * that inserts a face and hands it to assignFaces with that transaction.
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards. Not run locally.
 */
const knex = require('knex');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

(pgUrl ? describe : describe.skip)('recluster against a face scan (pg, issue 2112)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let clustering;

  beforeAll(async () => {
    schema = `face_recluster_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'face-recluster-pg-test-secret-at-least-32-chars';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-face-recluster-pg-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());
    clustering = require('../../src/services/faceClustering');
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices().catch(() => {});
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  /** Deterministic unit vector for identity `id`, jittered by `variant`. */
  function makeEmbedding(id, variant = 0, dim = 64) {
    const vec = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      vec[i] = Math.sin((i + 1) * (id + 1) * 0.7) + variant * 0.02 * Math.cos(i * 3.1);
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i] /= norm;
    return vec;
  }

  async function seedEvent() {
    const slug = `recluster-${crypto.randomUUID().slice(0, 8)}`;
    const [row] = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `${slug}-share`, expires_at: new Date(Date.now() + 86400000).toISOString(),
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async function insertFace(conn, eventId, embedding) {
    const [p] = await conn('photos').insert({
      event_id: eventId, filename: `${crypto.randomUUID()}.jpg`, path: '/tmp/x.jpg', type: 'individual',
    }).returning('id');
    const row = {
      photo_id: typeof p === 'object' ? p.id : p,
      event_id: eventId,
      bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200,
      det_score: 0.99,
      embedding: clustering.packEmbedding(embedding),
      model_version: 'test-v1',
      created_at: new Date().toISOString(),
    };
    const [f] = await conn('photo_faces').insert(row).returning('id');
    return { ...row, id: typeof f === 'object' ? f.id : f };
  }

  async function seedPeople(eventId) {
    const faces = [];
    for (let v = 0; v < 3; v++) {
      for (const id of [81, 82]) faces.push(await insertFace(db, eventId, makeEmbedding(id, v)));
    }
    await clustering.assignFaces(eventId, faces);
  }

  // Backends parked on this event's clustering lock.
  const waitingOnEventLock = async (eventId) => {
    const { rows } = await owner.raw(
      'SELECT count(*) AS n FROM pg_locks WHERE locktype = ? AND NOT granted AND classid = ? AND objid = ? AND objsubid = 2',
      ['advisory', 1074, eventId],
    );
    return Number(rows[0].n);
  };
  // How many backends wait, directly or through another waiter, on `pid`.
  const behind = async (pid) => {
    const { rows } = await owner.raw(
      'WITH RECURSIVE w(pid) AS ('
      + ' SELECT pid FROM pg_stat_activity WHERE CAST(? AS int) = ANY(pg_blocking_pids(pid))'
      + ' UNION SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))'
      + ') SELECT count(*) AS n FROM w',
      [pid],
    );
    return Number(rows[0].n);
  };
  const backendPid = async (trx) => (await trx.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  // True once `done` holds, false after ten seconds.
  const until = async (done) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
  };
  const rollback = async (trx) => { if (!trx.isCompleted()) await trx.rollback(); };
  const settled = (results, name, promise) => promise.then(
    () => { results[name] = 'ok'; },
    (e) => { results[name] = e; },
  );
  const unassigned = async (eventId) => Number((await db('photo_faces')
    .where({ event_id: eventId }).whereNull('person_id').count({ c: '*' }).first()).c);

  test('a recluster waits for a scan holding the event lock, then both finish', async () => {
    const eventId = await seedEvent();
    await seedPeople(eventId);

    // A scan past assignFaces, not yet committed: the advisory lock stays
    // held until the transaction ends.
    const scan = await db.transaction();
    const results = {};
    const pending = [];
    try {
      const face = await insertFace(scan, eventId, makeEmbedding(81, 4));
      await clustering.assignFaces(eventId, [face], { trx: scan });

      // Before the fix the recluster never asked for the advisory lock: it
      // cleared and re-assigned the people around the open scan.
      pending.push(settled(results, 'recluster', clustering.recluster(eventId)));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 1)).toBe(true);
      // Still the scan's view until it commits.
      expect(Number((await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).c)).toBe(2);

      pending.push(settled(results, 'scan', scan.commit()));
      await Promise.all(pending);
    } finally {
      await rollback(scan);
      await Promise.all(pending);
    }

    expect(results).toEqual({ scan: 'ok', recluster: 'ok' });
    // The recluster ran after the scan and so re-grouped its face too.
    expect(await unassigned(eventId)).toBe(0);
    expect(Number((await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).c)).toBe(2);
  }, 60000);

  test('a scan waits for a recluster in progress, then both finish', async () => {
    const eventId = await seedEvent();
    await seedPeople(eventId);
    const [held] = await db('photo_faces').where({ event_id: eventId }).orderBy('id').limit(1);

    // Holds one face row, so the recluster parks part-way, under the event
    // lock, on clearing it.
    const blocker = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await blocker('photo_faces').where({ id: held.id }).forUpdate().first();
      const pid = await backendPid(blocker);
      pending.push(settled(results, 'recluster', clustering.recluster(eventId)));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      // A scan of a new photo of the same event: it inserts its face, then
      // waits in assignFaces for the advisory lock the recluster holds.
      pending.push(settled(results, 'scan', db.transaction(async (trx) => {
        const face = await insertFace(trx, eventId, makeEmbedding(82, 4));
        await clustering.assignFaces(eventId, [face], { trx });
      })));
      // Mid-recluster, other readers still see the event's people.
      expect(Number((await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).c)).toBe(2);

      await blocker.commit();
      await Promise.all(pending);
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

    expect(results).toEqual({ recluster: 'ok', scan: 'ok' });
    // The scan ran after the recluster and joined its face to a person.
    expect(await unassigned(eventId)).toBe(0);
    expect(Number((await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).c)).toBe(2);
  }, 60000);

  test('a re-scan that rebuilt its old people first never hangs a recluster or another scan', async () => {
    const eventId = await seedEvent();
    await seedPeople(eventId);
    const [old] = await db('photo_faces').where({ event_id: eventId }).orderBy('id').limit(1);

    // processPhotoFaces' opening on a photo it scanned before: delete the old
    // face and rebuild its person, both before assignFaces asks for the lock.
    const scan = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await scan('photo_faces').where({ id: old.id }).del();
      await clustering.recomputeCentroid(old.person_id, scan);
      const pid = await backendPid(scan);

      // Takes the advisory lock, then waits for the rows the scan holds. With
      // the in-process mutex also held, the scan below parked on it in Node
      // and neither side ever finished.
      pending.push(settled(results, 'recluster', clustering.recluster(eventId)));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      // A second worker of this process scanning a new photo waits for the
      // recluster's advisory lock. Had it taken the in-process mutex first,
      // the re-scan below would park behind it in Node: a three-way cycle
      // PostgreSQL cannot see.
      pending.push(settled(results, 'other', db.transaction(async (trx) => {
        const face = await insertFace(trx, eventId, makeEmbedding(82, 5));
        await clustering.assignFaces(eventId, [face], { trx });
      })));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 1)).toBe(true);

      pending.push(settled(results, 'scan', (async () => {
        const [photo] = await scan('photos').where({ id: old.photo_id }).select('id');
        const row = {
          photo_id: photo.id, event_id: eventId, bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200,
          det_score: 0.99, embedding: clustering.packEmbedding(makeEmbedding(81, 5)),
          model_version: 'test-v1', created_at: new Date().toISOString(),
        };
        try {
          const [f] = await scan('photo_faces').insert(row).returning('id');
          await clustering.assignFaces(eventId, [{ ...row, id: typeof f === 'object' ? f.id : f }], { trx: scan });
          await scan.commit();
        } catch (err) {
          // An aborted transaction keeps its locks until it is rolled back.
          await rollback(scan);
          throw err;
        }
      })()));
      await Promise.all(pending);
    } finally {
      await rollback(scan);
      await Promise.all(pending);
    }

    // Without the scan-side lock (issue 2069) PostgreSQL may still see a
    // cycle here, and breaks it: a recluster that loses runs once more, a scan
    // that loses rolls back and is retried by the queue.
    expect(results.recluster).toBe('ok');
    expect(results.other).toBe('ok');
    if (results.scan !== 'ok') expect(results.scan).toMatchObject({ code: '40P01' });
    expect(await unassigned(eventId)).toBe(0);
  }, 60000);

  test('a gallery delete holding the event row and a recluster both finish', async () => {
    const eventId = await seedEvent();
    await seedPeople(eventId);

    // deleteEventCascade's order: the event row FOR UPDATE, then its faces
    // and people, then the rest.
    const del = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await del('events').where({ id: eventId }).forUpdate().first();
      const pid = await backendPid(del);
      // Parks on the event row before it locks a face. Without that it
      // cleared the faces first and then waited on the event row for the
      // event FK of the first person it inserted: 40P01 against the delete.
      pending.push(settled(results, 'recluster', clustering.recluster(eventId)));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      pending.push(settled(results, 'delete', (async () => {
        await del('photo_faces').where({ event_id: eventId }).del();
        await del('event_people').where({ event_id: eventId }).del();
        await del('photos').where({ event_id: eventId }).del();
        await del('events').where({ id: eventId }).del();
        await del.commit();
      })()));
      await Promise.all(pending);
    } finally {
      await rollback(del);
      await Promise.all(pending);
    }

    expect(results).toEqual({ delete: 'ok', recluster: 'ok' });
    expect(await db('events').where({ id: eventId }).first()).toBeUndefined();
    expect(Number((await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first()).c)).toBe(0);
  }, 60000);
});
