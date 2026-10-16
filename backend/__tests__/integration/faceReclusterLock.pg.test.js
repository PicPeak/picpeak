/**
 * Re-grouping people against a face scan of the same event, on PostgreSQL
 * (issue 2112).
 *
 * recluster() cleared the event's people in one transaction and re-assigned
 * them without one, so assignFaces took the in-process lock but never the
 * event's advisory lock, pg_advisory_xact_lock(1074, event). It now runs as
 * one transaction under the advisory lock (and never holds the in-process
 * mutex while it waits in PostgreSQL), scans take that lock before any face
 * or person row, and every test here has both sides finish.
 *
 * Connections run with a lock_timeout, so a wait PostgreSQL cannot resolve
 * (one side parked in Node) fails the test instead of hanging it.
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards. Not run locally.
 */
const knex = require('knex');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

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

let mockPreviewBuffer;
const mockDetected = [];

(pgUrl ? describe : describe.skip)('recluster against a face scan (pg, issue 2112)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let clustering; let faceProcessor;

  beforeAll(async () => {
    const sharp = require('sharp');
    mockPreviewBuffer = await sharp({
      create: { width: 1920, height: 1440, channels: 3, background: { r: 20, g: 40, b: 80 } },
    }).jpeg().toBuffer();
    // The scan's storage and sidecar halves are not what is under test.
    jest.doMock('../../src/services/imageProcessor', () => ({
      ...jest.requireActual('../../src/services/imageProcessor'),
      ensurePreviewImage: async () => 'previews/preview_test.jpg',
    }));
    jest.doMock('../../src/services/storage', () => ({
      ...jest.requireActual('../../src/services/storage'),
      getStorage: () => ({ get: async () => mockPreviewBuffer }),
    }));
    jest.doMock('../../src/services/faceClient', () => ({
      ...jest.requireActual('../../src/services/faceClient'),
      detectFaces: async () => ({
        model_version: 'test-v1',
        faces: [{ bbox: [10, 10, 400, 400], score: 0.99, yaw: 0, pitch: 0, blur: 500, embedding: mockDetected.shift() }],
      }),
    }));

    schema = `face_recluster_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'face-recluster-pg-test-secret-at-least-32-chars';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-face-recluster-pg-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({
      client: 'pg',
      connection: pgUrl,
      searchPath: [schema],
      pool: { afterCreate: (conn, done) => conn.query('SET lock_timeout = 20000', (err) => done(err, conn)) },
    }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());
    await db('feature_flags').insert({ key: 'faces', value: true }).onConflict('key').merge();
    clustering = require('../../src/services/faceClustering');
    faceProcessor = require('../../src/services/faceProcessor');
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices().catch(() => {});
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  async function seedEvent() {
    const slug = `recluster-${crypto.randomUUID().slice(0, 8)}`;
    const [row] = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `${slug}-share`, expires_at: new Date(Date.now() + 86400000).toISOString(),
      face_recognition_enabled: true,
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async function seedPhoto(conn, eventId, extra = {}) {
    const [p] = await conn('photos').insert({
      event_id: eventId, filename: `${crypto.randomUUID()}.jpg`, path: '/tmp/x.jpg', type: 'individual',
      width: 1920, height: 1440, ...extra,
    }).returning('id');
    return typeof p === 'object' ? p.id : p;
  }

  async function insertFace(conn, eventId, embedding, photoId) {
    const row = {
      photo_id: photoId || await seedPhoto(conn, eventId),
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
    return faces;
  }

  // A photo claimed by the face queue, as processPhotoFaces expects it: the
  // claimed row, its attempt id included (issue 2069).
  const claim = async (photoId) => {
    const claimed = { id: photoId, face_attempt_id: crypto.randomUUID() };
    await db('photos').where({ id: photoId }).update({
      face_status: 'processing', face_started_at: new Date().toISOString(), face_attempt_id: claimed.face_attempt_id,
    });
    return claimed;
  };

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
  // processPhotoFaces reports its outcome rather than throwing for most.
  const scanned = (results, name, promise) => promise.then(
    (value) => { results[name] = value; },
    (e) => { results[name] = e; },
  );
  const peopleCount = async (eventId) => Number((await db('event_people')
    .where({ event_id: eventId }).count({ c: '*' }).first()).c);
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
      expect(await peopleCount(eventId)).toBe(2);

      pending.push(settled(results, 'scan', scan.commit()));
      await Promise.all(pending);
    } finally {
      await rollback(scan);
      await Promise.all(pending);
    }

    expect(results).toEqual({ scan: 'ok', recluster: 'ok' });
    // The recluster ran after the scan and so re-grouped its face too.
    expect(await unassigned(eventId)).toBe(0);
    expect(await peopleCount(eventId)).toBe(2);
  }, 60000);

  test('a re-scan and a new scan wait for a recluster in progress, then all finish', async () => {
    const eventId = await seedEvent();
    const [old] = await seedPeople(eventId);
    const [held] = await db('photo_faces').where({ event_id: eventId }).orderBy('id', 'desc').limit(1);

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
      expect(await waitingOnEventLock(eventId)).toBe(0);

      // A re-scan of a photo scanned before: it takes the event lock before it
      // deletes its old face. Deleting first, it held that row while the
      // recluster waited for it, then waited for the lock itself: 40P01, and
      // a scan that loses is failed rather than retried.
      const rescan = await claim(old.photo_id);
      mockDetected.push(Array.from(makeEmbedding(81, 5)));
      pending.push(scanned(results, 'rescan', faceProcessor.processPhotoFaces(rescan)));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 1)).toBe(true);

      // A second worker of this process on a new photo. Had withEventLock
      // taken the in-process mutex before the advisory lock, a worker parked
      // in PostgreSQL would hold it while the others waited for it in Node.
      const fresh = await claim(await seedPhoto(db, eventId));
      mockDetected.push(Array.from(makeEmbedding(82, 5)));
      pending.push(scanned(results, 'scan', faceProcessor.processPhotoFaces(fresh)));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 2)).toBe(true);
      // Mid-recluster, other readers still see the event's people.
      expect(await peopleCount(eventId)).toBe(2);

      await blocker.commit();
      await Promise.all(pending);
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

    expect(results.recluster).toBe('ok');
    expect(results.rescan).toMatchObject({ status: 'done' });
    expect(results.scan).toMatchObject({ status: 'done' });
    expect(await unassigned(eventId)).toBe(0);
    expect(await peopleCount(eventId)).toBe(2);
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
    expect(await peopleCount(eventId)).toBe(0);
  }, 60000);
});
