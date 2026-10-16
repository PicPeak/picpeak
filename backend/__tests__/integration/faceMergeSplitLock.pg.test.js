/**
 * Merging and splitting people against a face assignment of the same event,
 * on PostgreSQL (issue 2119).
 *
 * mergePeople and splitPerson moved faces between people without the event's
 * clustering lock, pg_advisory_xact_lock(1074, event), that assignFaces takes.
 * A merge deleted a source person a scan had just assigned a face to, and a
 * split recomputed a person from a member list a scan changed under it. Both
 * now take the lock first in their transaction, a scan takes it before it
 * touches a face or person row, and assignFaces asks for it before the
 * in-process mutex, so a worker parked on it in PostgreSQL never holds that
 * mutex.
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

(pgUrl ? describe : describe.skip)('merge and split against face assignment (pg, issue 2119)', () => {
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

    schema = `face_merge_split_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'face-merge-split-pg-test-secret-at-least-32-chars';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-face-merge-split-pg-'));
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
    const slug = `merge-split-${crypto.randomUUID().slice(0, 8)}`;
    const [row] = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `${slug}-share`, expires_at: new Date(Date.now() + 86400000).toISOString(),
      face_recognition_enabled: true,
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async function insertFace(conn, eventId, embedding) {
    const [p] = await conn('photos').insert({
      event_id: eventId, filename: `${crypto.randomUUID()}.jpg`, path: '/tmp/x.jpg', type: 'individual',
      width: 1920, height: 1440,
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

  // Two people, identities 81 and 82, three faces each.
  async function seedPeople(eventId) {
    const faces = [];
    for (let v = 0; v < 3; v++) {
      for (const id of [81, 82]) faces.push(await insertFace(db, eventId, makeEmbedding(id, v)));
    }
    await clustering.assignFaces(eventId, faces);
    const personOf = async (face) => (await db('photo_faces').where({ id: face.id }).first('person_id')).person_id;
    const anna = await personOf(faces[0]);
    const ben = await personOf(faces[1]);
    expect(anna).not.toBe(ben);
    return { faces, anna, ben };
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
  // A face scan's clustering half: a new face assigned in its own transaction.
  const scan = (eventId, embedding) => db.transaction(async (trx) => {
    const face = await insertFace(trx, eventId, embedding);
    await clustering.assignFaces(eventId, [face], { trx });
  });
  // processPhotoFaces reports its outcome rather than throwing for most.
  const scanned = (results, name, promise) => promise.then(
    (value) => { results[name] = value; },
    (e) => { results[name] = e; },
  );
  // A photo claimed by the face queue, as processPhotoFaces expects it.
  // The claimed row, its attempt id included (issue 2069).
  const claim = async (photoId) => {
    const claimed = { id: photoId, face_attempt_id: crypto.randomUUID() };
    await db('photos').where({ id: photoId }).update({
      face_status: 'processing', face_started_at: new Date().toISOString(), face_attempt_id: claimed.face_attempt_id,
    });
    return claimed;
  };
  const members = async (personId) => Number((await db('photo_faces')
    .where({ person_id: personId }).count({ c: '*' }).first()).c);
  const unassigned = async (eventId) => Number((await db('photo_faces')
    .where({ event_id: eventId }).whereNull('person_id').count({ c: '*' }).first()).c);

  test('a merge waits for a scan holding the event lock and takes its face along', async () => {
    const eventId = await seedEvent();
    const { anna, ben } = await seedPeople(eventId);

    // A scan past assignFaces, not yet committed: its new face sits on Ben,
    // and the advisory lock stays held until the transaction ends.
    const open = await db.transaction();
    const results = {};
    const pending = [];
    try {
      const face = await insertFace(open, eventId, makeEmbedding(82, 4));
      await clustering.assignFaces(eventId, [face], { trx: open });
      expect((await open('photo_faces').where({ id: face.id }).first('person_id')).person_id).toBe(ben);

      // Before the fix the merge moved Ben's committed faces around the open
      // scan, then deleted Ben once it committed: the scan's face lost its
      // person.
      pending.push(settled(results, 'merge', clustering.mergePeople(eventId, [ben], anna)));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 1)).toBe(true);

      pending.push(settled(results, 'scan', open.commit()));
      await Promise.all(pending);
    } finally {
      await rollback(open);
      await Promise.all(pending);
    }

    expect(results).toEqual({ scan: 'ok', merge: 'ok' });
    expect(await unassigned(eventId)).toBe(0);
    expect(await db('event_people').where({ id: ben }).first()).toBeUndefined();
    expect(await members(anna)).toBe(7);
    expect((await db('event_people').where({ id: anna }).first()).face_count_total).toBe(7);
  }, 60000);

  test('a split waits for a scan holding the event lock and counts its face', async () => {
    const eventId = await seedEvent();
    const { faces, anna } = await seedPeople(eventId);

    const open = await db.transaction();
    const results = {};
    const pending = [];
    let newPerson;
    try {
      const face = await insertFace(open, eventId, makeEmbedding(81, 4));
      await clustering.assignFaces(eventId, [face], { trx: open });
      expect((await open('photo_faces').where({ id: face.id }).first('person_id')).person_id).toBe(anna);

      // Before the fix the split read Anna's members around the open scan,
      // then wrote her count and centroid from that list once it committed.
      pending.push(settled(results, 'split', clustering.splitPerson(eventId, anna, [faces[0].id])
        .then((id) => { newPerson = id; })));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 1)).toBe(true);

      pending.push(settled(results, 'scan', open.commit()));
      await Promise.all(pending);
    } finally {
      await rollback(open);
      await Promise.all(pending);
    }

    expect(results).toEqual({ scan: 'ok', split: 'ok' });
    expect(await members(anna)).toBe(3);
    expect((await db('event_people').where({ id: anna }).first()).face_count_total).toBe(3);
    expect(await members(newPerson)).toBe(1);
  }, 60000);

  test('two scans arriving during a merge both wait in PostgreSQL, then all finish', async () => {
    const eventId = await seedEvent();
    const { faces, anna, ben } = await seedPeople(eventId);

    // Holds one of Ben's faces, so the merge parks under the event lock on
    // moving it.
    const blocker = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await blocker('photo_faces').where({ id: faces[1].id }).forUpdate().first();
      const pid = await backendPid(blocker);
      pending.push(settled(results, 'merge', clustering.mergePeople(eventId, [ben], anna)));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      // Two workers of this process. Had assignFaces taken the in-process
      // mutex before the advisory lock, the first would hold it while parked
      // in PostgreSQL and the second would wait for it in Node, out of
      // PostgreSQL's sight.
      pending.push(settled(results, 'scan1', scan(eventId, makeEmbedding(81, 5))));
      pending.push(settled(results, 'scan2', scan(eventId, makeEmbedding(82, 5))));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 2)).toBe(true);

      await blocker.commit();
      await Promise.all(pending);
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

    expect(results).toEqual({ merge: 'ok', scan1: 'ok', scan2: 'ok' });
    expect(await unassigned(eventId)).toBe(0);
    expect(await db('event_people').where({ id: ben }).first()).toBeUndefined();
  }, 60000);

  test('a scan arriving during a split waits for it, then both finish', async () => {
    const eventId = await seedEvent();
    const { faces, anna } = await seedPeople(eventId);

    // Holds the face being split out, so the split parks under the event
    // lock on moving it.
    const blocker = await db.transaction();
    const results = {};
    const pending = [];
    let newPerson;
    try {
      await blocker('photo_faces').where({ id: faces[0].id }).forUpdate().first();
      const pid = await backendPid(blocker);
      pending.push(settled(results, 'split', clustering.splitPerson(eventId, anna, [faces[0].id])
        .then((id) => { newPerson = id; })));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      pending.push(settled(results, 'scan', scan(eventId, makeEmbedding(81, 5))));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 1)).toBe(true);

      await blocker.commit();
      await Promise.all(pending);
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

    expect(results).toEqual({ split: 'ok', scan: 'ok' });
    expect(await unassigned(eventId)).toBe(0);
    expect(await members(newPerson)).toBeGreaterThanOrEqual(1);
    const annaRow = await db('event_people').where({ id: anna }).first();
    expect(annaRow.face_count_total).toBe(await members(anna));
  }, 60000);

  test('a re-scan during a merge waits for the lock before it deletes its old face', async () => {
    const eventId = await seedEvent();
    const { faces, anna, ben } = await seedPeople(eventId);
    // Ben's last face, re-scanned while the merge is parked on his first.
    const rescanned = faces[5];

    const blocker = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await blocker('photo_faces').where({ id: faces[1].id }).forUpdate().first();
      const pid = await backendPid(blocker);
      pending.push(settled(results, 'merge', clustering.mergePeople(eventId, [ben], anna)));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      // Deleting its old face first, the re-scan held that row while the
      // merge went on to move it, then waited in assignFaces for the lock
      // the merge holds: 40P01, and either side failed.
      const rescan = await claim(rescanned.photo_id);
      mockDetected.push(Array.from(makeEmbedding(82, 5)));
      pending.push(scanned(results, 'rescan', faceProcessor.processPhotoFaces(rescan)));
      expect(await until(async () => (await waitingOnEventLock(eventId)) >= 1)).toBe(true);
      // Parked before its delete: the old face row is still free to lock.
      // The merge stopped at Ben's first face and has not reached it either.
      await expect(db.transaction((t) => t('photo_faces').where({ id: rescanned.id })
        .forUpdate().noWait().first('id'))).resolves.toEqual({ id: rescanned.id });

      await blocker.commit();
      await Promise.all(pending);
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

    expect(results.merge).toBe('ok');
    expect(results.rescan).toMatchObject({ status: 'done' });
    expect(await db('photo_faces').where({ id: rescanned.id }).first()).toBeUndefined();
    expect(await unassigned(eventId)).toBe(0);
    expect(await db('event_people').where({ id: ben }).first()).toBeUndefined();
  }, 60000);
});
