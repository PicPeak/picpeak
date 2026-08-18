/**
 * Clustering engine (#1074).
 *
 * Uses synthetic embeddings with known identities rather than real faces: the
 * question here is whether the ALGORITHM groups vectors correctly, which is
 * separable from whether the model produces good vectors. Model quality is
 * the spike's job.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-faceclust-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'faceclust-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let clustering;

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

async function seedEvent(slug) {
  const [row] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `${slug}-share`,
    expires_at: new Date().toISOString(),
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

async function insertFace(eventId, embedding, overrides = {}) {
  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: `${Math.random()}.jpg`,
    path: '/tmp/x.jpg',
    type: 'individual',
  }).returning('id');
  const photoId = typeof p === 'object' ? p.id : p;

  const row = {
    photo_id: photoId,
    event_id: eventId,
    bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200,
    det_score: 0.99,
    embedding: clustering.packEmbedding(embedding),
    model_version: 'test-v1',
    created_at: new Date().toISOString(),
    ...overrides,
  };
  const [f] = await db('photo_faces').insert(row).returning('id');
  return { ...row, id: typeof f === 'object' ? f.id : f };
}

describe('faceClustering (#1074)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    clustering = require('../../src/services/faceClustering');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('embedding round-trip', () => {
    it('survives pack/unpack through the BLOB column exactly', async () => {
      const original = makeEmbedding(1);
      const eventId = await seedEvent('roundtrip');
      const face = await insertFace(eventId, original);

      const stored = await db('photo_faces').where({ id: face.id }).first();
      const restored = clustering.unpackEmbedding(stored.embedding);

      expect(restored).toHaveLength(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 6);
      }
    });

    it('returns null for a corrupt blob rather than throwing', () => {
      expect(clustering.unpackEmbedding(Buffer.from([1, 2, 3]))).toBeNull();
      expect(clustering.unpackEmbedding(null)).toBeNull();
    });
  });

  describe('assignment', () => {
    it('groups the same identity and separates different ones', async () => {
      const eventId = await seedEvent('grouping');
      const faces = [];
      // Three identities, four shots each, interleaved so assignment order
      // is not conveniently grouped.
      for (let variant = 0; variant < 4; variant++) {
        for (const identity of [1, 2, 3]) {
          faces.push(await insertFace(eventId, makeEmbedding(identity, variant)));
        }
      }

      await clustering.assignFaces(eventId, faces);

      const people = await db('event_people').where({ event_id: eventId });
      expect(people).toHaveLength(3);

      // Every face of one identity must share a person id.
      const rows = await db('photo_faces').where({ event_id: eventId }).select('id', 'person_id');
      const byPerson = new Map();
      for (const r of rows) {
        byPerson.set(r.person_id, (byPerson.get(r.person_id) || 0) + 1);
      }
      expect([...byPerson.values()].sort()).toEqual([4, 4, 4]);
    });

    it('leaves low-quality faces unassigned instead of spawning junk people', async () => {
      const eventId = await seedEvent('quality-floor');
      const good = await insertFace(eventId, makeEmbedding(5));
      // Tiny bbox — below the 40px floor.
      const tiny = await insertFace(eventId, makeEmbedding(6), { bbox_w: 12, bbox_h: 12 });
      // Weak detection score.
      const weak = await insertFace(eventId, makeEmbedding(7), { det_score: 0.2 });

      await clustering.assignFaces(eventId, [good, tiny, weak]);

      const rows = await db('photo_faces')
        .whereIn('id', [good.id, tiny.id, weak.id])
        .select('id', 'person_id');
      const map = Object.fromEntries(rows.map((r) => [r.id, r.person_id]));

      expect(map[good.id]).not.toBeNull();
      // Still stored — they show in "this photo contains" — just unassigned.
      expect(map[tiny.id]).toBeNull();
      expect(map[weak.id]).toBeNull();
      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(1);
    });

    it('never mixes embedding spaces from different model versions', async () => {
      const eventId = await seedEvent('model-version');
      const a = await insertFace(eventId, makeEmbedding(9), { model_version: 'v1' });
      await clustering.assignFaces(eventId, [a]);

      // Same vector, different model. Comparable numerically, meaningless
      // semantically — it must NOT join the v1 cluster.
      const b = await insertFace(eventId, makeEmbedding(9), { model_version: 'v2' });
      await clustering.assignFaces(eventId, [b]);

      const people = await db('event_people').where({ event_id: eventId });
      expect(people).toHaveLength(2);
    });
  });

  describe('merge and split', () => {
    it('merge moves every face and removes the source person', async () => {
      const eventId = await seedEvent('merge');
      const f1 = await insertFace(eventId, makeEmbedding(11));
      const f2 = await insertFace(eventId, makeEmbedding(21));
      await clustering.assignFaces(eventId, [f1, f2]);

      const people = await db('event_people').where({ event_id: eventId }).orderBy('id');
      expect(people).toHaveLength(2);

      await clustering.mergePeople(eventId, [people[1].id], people[0].id);

      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(1);
      const remaining = await db('event_people').where({ event_id: eventId }).first();
      expect(remaining.face_count_total).toBe(2);
      const orphaned = await db('photo_faces')
        .where({ event_id: eventId }).whereNull('person_id');
      expect(orphaned).toHaveLength(0);
    });

    it('split pulls the named faces into a new person', async () => {
      const eventId = await seedEvent('split');
      const faces = [];
      for (let v = 0; v < 4; v++) faces.push(await insertFace(eventId, makeEmbedding(13, v)));
      await clustering.assignFaces(eventId, faces);

      const person = await db('event_people').where({ event_id: eventId }).first();
      expect(person.face_count_total).toBe(4);

      const newId = await clustering.splitPerson(eventId, person.id, [faces[0].id, faces[1].id]);
      expect(newId).toBeTruthy();

      const original = await db('event_people').where({ id: person.id }).first();
      const created = await db('event_people').where({ id: newId }).first();
      expect(original.face_count_total).toBe(2);
      expect(created.face_count_total).toBe(2);
    });

    it('deletes a person left with no faces rather than keeping a ghost', async () => {
      const eventId = await seedEvent('empty-person');
      const f = await insertFace(eventId, makeEmbedding(15));
      await clustering.assignFaces(eventId, [f]);
      const person = await db('event_people').where({ event_id: eventId }).first();

      await db('photo_faces').where({ id: f.id }).update({ person_id: null });
      await clustering.recomputeCentroid(person.id);

      expect(await db('event_people').where({ id: person.id }).first()).toBeUndefined();
    });
  });

  describe('regressions from external review', () => {
    it('merge carries a name and suppression onto the survivor', async () => {
      // A merge used to move the faces and delete the source outright, so a
      // photographer-entered name vanished and a person they had hidden came
      // back guest-visible.
      const eventId = await seedEvent('merge-metadata');
      const a = await insertFace(eventId, makeEmbedding(61));
      const b = await insertFace(eventId, makeEmbedding(62));
      await clustering.assignFaces(eventId, [a, b]);

      const [p1, p2] = await db('event_people').where({ event_id: eventId }).orderBy('id');
      // Target is unnamed and visible; the SOURCE carries the human state.
      await db('event_people').where({ id: p2.id }).update({ label: 'Anna', is_hidden: true });

      await clustering.mergePeople(eventId, [p2.id], p1.id);

      const survivor = await db('event_people').where({ id: p1.id }).first();
      expect(survivor.label).toBe('Anna');
      expect(!!survivor.is_hidden).toBe(true);
    });

    it('recluster keeps hidden/ignored on people that were never named', async () => {
      // The old query remembered only rows with a label, so a suppressed
      // bystander came back visible after one "Re-group people".
      const eventId = await seedEvent('recluster-suppression');
      const faces = [];
      for (let v = 0; v < 3; v++) faces.push(await insertFace(eventId, makeEmbedding(71, v)));
      await clustering.assignFaces(eventId, faces);

      const person = await db('event_people').where({ event_id: eventId }).first();
      expect(person.label).toBeNull();
      await db('event_people').where({ id: person.id }).update({ is_ignored: true });

      await clustering.recluster(eventId);

      const after = await db('event_people').where({ event_id: eventId });
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((p) => !!p.is_ignored)).toBe(true);
    });
  });

  describe('recluster', () => {
    it('re-derives clusters and preserves photographer-assigned names', async () => {
      // This is the property that makes re-clustering safe to offer as a
      // button: without it, one click silently discards every typed name.
      const eventId = await seedEvent('recluster');
      const faces = [];
      for (let v = 0; v < 3; v++) {
        faces.push(await insertFace(eventId, makeEmbedding(31, v)));
        faces.push(await insertFace(eventId, makeEmbedding(32, v)));
      }
      await clustering.assignFaces(eventId, faces);

      const people = await db('event_people').where({ event_id: eventId }).orderBy('id');
      expect(people).toHaveLength(2);
      await db('event_people').where({ id: people[0].id }).update({ label: 'Anna' });
      await db('event_people').where({ id: people[1].id }).update({ label: 'Ben' });

      const count = await clustering.recluster(eventId);
      expect(count).toBe(2);

      const after = await db('event_people').where({ event_id: eventId });
      const labels = after.map((p) => p.label).filter(Boolean).sort();
      expect(labels).toEqual(['Anna', 'Ben']);
    });

    it('is stable across repeated runs', async () => {
      const eventId = await seedEvent('recluster-stable');
      const faces = [];
      for (let v = 0; v < 3; v++) {
        for (const id of [41, 42]) faces.push(await insertFace(eventId, makeEmbedding(id, v)));
      }
      await clustering.assignFaces(eventId, faces);

      const first = await clustering.recluster(eventId);
      const second = await clustering.recluster(eventId);
      expect(second).toBe(first);
    });
  });

  describe('consolidate', () => {
    it('refuses to merge two people the photographer named differently', async () => {
      // A human assertion this heuristic does not get to overrule.
      const eventId = await seedEvent('consolidate-labels');
      const a = await insertFace(eventId, makeEmbedding(51));
      await clustering.assignFaces(eventId, [a]);
      const first = await db('event_people').where({ event_id: eventId }).first();

      // A near-identical centroid that would otherwise merge.
      const [inserted] = await db('event_people').insert({
        event_id: eventId,
        centroid: clustering.packEmbedding(makeEmbedding(51, 0.01)),
        face_count_total: 1,
        model_version: 'test-v1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const secondId = typeof inserted === 'object' ? inserted.id : inserted;

      await db('event_people').where({ id: first.id }).update({ label: 'Anna' });
      await db('event_people').where({ id: secondId }).update({ label: 'Ben' });

      await clustering.consolidate(eventId);

      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(2);
    });
  });
});
