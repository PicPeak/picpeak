/**
 * "Not the same person" has to outlive re-derivation (#1132).
 *
 * The decision used to be stored as a pair of event_people.id, and neither
 * person ids nor face ids survive:
 *
 *   - recluster() deletes every person and re-assigns, so person ids die but
 *     photo_faces.id survives
 *   - a full re-scan replaces a photo's faces outright, so FACE ids die too
 *
 * The embedding is the only stable handle, so that is what the separation is
 * keyed on. These tests simulate both kinds of re-derivation by destroying the
 * ids and rebuilding from the same vectors — which is exactly what the real
 * paths do — and assert the constraint still binds.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sep-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sep-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let clustering;

const THRESHOLDS = { face_match_threshold: 0.6, face_quality_min_score: 0.7, face_quality_min_px: 40 };
const DIM = 64;

/** Two unit vectors whose dot product is exactly `target`, on basis (i, i+1). */
function pairAtSimilarity(target, basis) {
  const a = new Float32Array(DIM);
  const b = new Float32Array(DIM);
  a[basis] = 1;
  b[basis] = target;
  b[basis + 1] = Math.sqrt(1 - target * target);
  return [a, b];
}

async function seedEvent(slug) {
  const [row] = await db('events').insert({
    slug, event_type: 'wedding', event_name: slug, event_date: '2026-01-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `${slug}-share`, expires_at: new Date().toISOString(),
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

async function insertPerson(eventId, centroid, overrides = {}) {
  const [row] = await db('event_people').insert({
    event_id: eventId,
    centroid: clustering.packEmbedding(centroid),
    face_count_total: 1,
    model_version: 'test-v1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

/** The mirror of pairAtSimilarity's second vector: same similarity, other side. */
function mirrorAtSimilarity(target, basis) {
  const b = new Float32Array(DIM);
  b[basis] = target;
  b[basis + 1] = -Math.sqrt(1 - target * target);
  return b;
}

async function insertFaceWithPhoto(eventId, personId, centroid) {
  const [p] = await db('photos').insert({
    event_id: eventId, filename: `${Math.random()}.jpg`, path: '/tmp/x.jpg', type: 'individual',
  }).returning('id');
  const photoId = typeof p === 'object' ? p.id : p;
  const [f] = await db('photo_faces').insert({
    photo_id: photoId, event_id: eventId, person_id: personId,
    bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200, det_score: 0.99,
    embedding: clustering.packEmbedding(centroid),
    model_version: 'test-v1', created_at: new Date().toISOString(),
  }).returning('id');
  return { faceId: typeof f === 'object' ? f.id : f, photoId };
}

async function insertFace(eventId, personId, centroid) {
  const { faceId } = await insertFaceWithPhoto(eventId, personId, centroid);
  return faceId;
}

/**
 * What a re-scan does to identity: the people are gone and the faces come back
 * with brand-new ids. Same vectors, nothing else preserved.
 */
async function simulateRescan(eventId, vectors) {
  await db('photo_faces').where({ event_id: eventId }).del();
  await db('event_people').where({ event_id: eventId }).del();
  const ids = [];
  for (const vec of vectors) {
    const personId = await insertPerson(eventId, vec);
    await insertFace(eventId, personId, vec);
    ids.push(personId);
  }
  return ids;
}

describe('separations survive re-derivation (#1132)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    clustering = require('../../src/services/faceClustering');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('the matcher', () => {
    it('binds a pair that still looks like the one that was separated', () => {
      const [a, b] = pairAtSimilarity(0.64, 0);
      expect(clustering.separationForbids(a, b, [{ a, b }])).toBe(true);
    });

    it('binds regardless of which way round the candidates arrive', () => {
      const [a, b] = pairAtSimilarity(0.64, 0);
      // Neither the stored pair nor the candidate pair has a meaningful order.
      expect(clustering.separationForbids(b, a, [{ a, b }])).toBe(true);
    });

    it('lapses once a side has drifted past recognition', () => {
      const [a, b] = pairAtSimilarity(0.64, 0);
      // A cluster reshaped far enough is no longer the cluster the
      // photographer pointed at, so the constraint should stop applying rather
      // than bind something they never saw.
      const drifted = new Float32Array(DIM);
      drifted[10] = 1;
      expect(clustering.separationForbids(drifted, b, [{ a, b }])).toBe(false);
    });

    it('does not bind two clusters that are both the SAME side', () => {
      // A split leaves two halves of one cluster, so the pair it records is
      // often similar to itself — here 0.95. Two candidates that are plainly
      // both side A (0.97 to each other) each clear the bar against BOTH
      // stored sides, so a test that only asks "does each side match
      // something" says yes and refuses to let that person cluster with
      // itself. It fragments into singletons — the person the split was not
      // even about.
      const [a, b] = pairAtSimilarity(0.95, 0);
      const x = new Float32Array(DIM); x[0] = 1;
      const y = mirrorAtSimilarity(0.97, 0);
      expect(clustering.separationForbids(x, y, [{ a, b }])).toBe(false);
      // The pair it was actually about still binds.
      expect(clustering.separationForbids(a, b, [{ a, b }])).toBe(true);
    });

    it('ignores a separation recorded under a different embedding model', () => {
      const [a, b] = pairAtSimilarity(0.64, 0);
      // Vectors from another model are meaningless here, not merely stale —
      // the same rule assignment and consolidation apply to person centroids.
      expect(clustering.separationForbids(a, b, [{ a, b, modelVersion: 'test-v2' }],
        { modelVersion: 'test-v1' })).toBe(false);
      expect(clustering.separationForbids(a, b, [{ a, b, modelVersion: 'test-v1' }],
        { modelVersion: 'test-v1' })).toBe(true);
    });

    it('ignores an unrelated pair entirely', () => {
      const [a, b] = pairAtSimilarity(0.64, 0);
      const [x, y] = pairAtSimilarity(0.64, 20);
      expect(clustering.separationForbids(x, y, [{ a, b }])).toBe(false);
    });
  });

  describe('across a re-scan', () => {
    it('still refuses to merge the pair after every id has changed', async () => {
      const eventId = await seedEvent('sep-rescan');
      // Well above the auto-merge threshold: only the separation keeps them apart.
      const [a, b] = pairAtSimilarity(0.97, 0);
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);
      await insertFace(eventId, idA, a);
      await insertFace(eventId, idB, b);

      await clustering.dismissMergeSuggestion(eventId, idA, idB);

      const newIds = await simulateRescan(eventId, [a, b]);
      // The premise: nothing the old row named still exists.
      expect(newIds).not.toContain(idA);
      expect(newIds).not.toContain(idB);

      const merged = await clustering.consolidate(eventId, { thresholds: THRESHOLDS });

      expect(merged).toEqual([]);
      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(2);
    });

    it('keeps the pair out of the suggestion list too', async () => {
      const eventId = await seedEvent('sep-rescan-suggest');
      const [a, b] = pairAtSimilarity(0.64, 0); // inside the suggestion band
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);

      await clustering.dismissMergeSuggestion(eventId, idA, idB);
      await simulateRescan(eventId, [a, b]);

      expect(await clustering.suggestMerges(eventId, { thresholds: THRESHOLDS })).toEqual([]);
    });

    it('a split still binds after the ids it recorded are gone', async () => {
      const eventId = await seedEvent('sep-split-rescan');
      // Two faces that look alike enough to have been clustered together, but
      // are not the same vector — which is what a split is FOR, and the only
      // case it can survive re-derivation in. Two byte-identical embeddings
      // carry no information about which side is which, so a separation
      // between them has nothing to key on once the ids are gone.
      const [base, other] = pairAtSimilarity(0.96, 0);
      const personId = await insertPerson(eventId, base);
      await insertFace(eventId, personId, base);
      const extra = await insertFace(eventId, personId, other);

      const newPersonId = await clustering.splitPerson(eventId, personId, [extra]);
      expect(newPersonId).toBeTruthy();

      // The snapshot must have been taken AFTER recomputeCentroid — before it,
      // the new person has no centroid at all.
      const row = await db('event_people_merge_dismissals').where({ event_id: eventId }).first();
      expect(row.centroid_a).toBeTruthy();
      expect(row.centroid_b).toBeTruthy();

      await simulateRescan(eventId, [base, other]);
      expect(await clustering.consolidate(eventId, { thresholds: THRESHOLDS })).toEqual([]);
    });
  });

  describe('when a photo is hard-deleted', () => {
    const { purgePhotoFaces } = require('../../src/services/faceProcessor');

    it('drops the separation when one side has no photos left', async () => {
      const eventId = await seedEvent('sep-purge-gone');
      const [a, b] = pairAtSimilarity(0.64, 0);
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);
      await insertFace(eventId, idA, a);
      const { photoId } = await insertFaceWithPhoto(eventId, idB, b);

      await clustering.dismissMergeSuggestion(eventId, idA, idB);
      await purgePhotoFaces(photoId);

      // Person B is gone with its only photo. The row held a COPY of its
      // centroid, so leaving it standing would keep a vector derived from a
      // deleted photo alive in a table nothing else touches.
      expect(await db('event_people').where({ id: idB }).first()).toBeUndefined();
      expect(await db('event_people_merge_dismissals').where({ event_id: eventId })).toHaveLength(0);
    });

    it('re-takes the snapshot from what is left when the person survives', async () => {
      const eventId = await seedEvent('sep-purge-survives');
      const [a, b] = pairAtSimilarity(0.64, 0);
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);
      await insertFace(eventId, idA, a);
      await insertFace(eventId, idB, b);
      // A second, different face on B — so purging the first one moves B's
      // centroid rather than deleting the person.
      const other = mirrorAtSimilarity(0.9, 0);
      const { photoId } = await insertFaceWithPhoto(eventId, idB, other);
      await clustering.recomputeCentroid(idB);

      await clustering.dismissMergeSuggestion(eventId, idA, idB);
      const before = await db('event_people_merge_dismissals').where({ event_id: eventId }).first();

      await purgePhotoFaces(photoId);

      const after = await db('event_people_merge_dismissals').where({ event_id: eventId }).first();
      expect(after).toBeTruthy();
      expect(Buffer.from(after.centroid_b).equals(Buffer.from(before.centroid_b))).toBe(false);
      // It now equals the recomputed centroid — nothing of the deleted face left.
      const person = await db('event_people').where({ id: idB }).first();
      expect(Buffer.from(after.centroid_b).equals(Buffer.from(person.centroid))).toBe(true);
    });
  });

  describe('when the whole gallery is deleted', () => {
    it('deleteEventCascade clears the separations too', () => {
      // Source inspection, deliberately. deleteEventCascade takes an admin
      // context and does filesystem cleanup, so driving it here would test the
      // scaffolding rather than the contract. The contract is narrow and
      // absolute: this table now holds centroid BLOBs, it has no event FK by
      // design, and nothing else in the codebase would ever reach it — so the
      // one delete has to be in the cascade or the embeddings outlive the
      // gallery. Same approach as the contract tests added for #596.
      const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'routes', 'adminEvents', 'helpers.js'), 'utf8'
      );
      const body = src.slice(src.indexOf('async function deleteEventCascade'));
      expect(body).toContain('event_people_merge_dismissals\').where(\'event_id\', eventId).del()');
      // Guarded, not caught: a failed statement aborts the transaction on PG.
      expect(body).toContain('hasTable(\'event_people_merge_dismissals\')');
    });
  });

  describe('during assignment', () => {
    it('will not put a new face into a cluster it was separated from', async () => {
      const eventId = await seedEvent('sep-assign');
      const [a, b] = pairAtSimilarity(0.97, 0);
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);
      await clustering.dismissMergeSuggestion(eventId, idA, idB);

      // A face that looks like side B arrives. Its nearest centroid is A (0.97,
      // far above the 0.6 match threshold), and before #1132 it would simply
      // have joined — reforming the pair the photographer pulled apart, because
      // assignment consulted no separations at all.
      await db('event_people').where({ id: idB }).del();
      const [p] = await db('photos').insert({
        event_id: eventId, filename: 'new.jpg', path: '/tmp/n.jpg', type: 'individual',
      }).returning('id');
      const photoId = typeof p === 'object' ? p.id : p;
      const [f] = await db('photo_faces').insert({
        photo_id: photoId, event_id: eventId,
        bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200, det_score: 0.99,
        embedding: clustering.packEmbedding(b), model_version: 'test-v1',
        created_at: new Date().toISOString(),
      }).returning('id');
      const faceId = typeof f === 'object' ? f.id : f;

      const assignments = await clustering.assignFaces(
        eventId, [{ id: faceId, embedding: clustering.packEmbedding(b), model_version: 'test-v1',
          det_score: 0.99, bbox_w: 200, bbox_h: 200 }],
        { thresholds: THRESHOLDS },
      );

      expect(assignments).toHaveLength(1);
      expect(assignments[0].personId).not.toBe(idA);
      // It opened its own person rather than being forced into the wrong one.
      expect(assignments[0].personId).toBeTruthy();
    });

    it('holds back a face that is only loosely like the side it belongs to', async () => {
      const eventId = await seedEvent('sep-assign-loose');
      // The separated sides are CENTROIDS; an individual face sits well below
      // its own centroid — that is why faces join at 0.6 and not at 0.92. A
      // face 0.85-like its own side would clear no strict bar against it, and
      // before this it walked straight into the other person during a
      // recluster, which is the exact merge the photographer undid.
      const [sideA, sideB] = pairAtSimilarity(0.7, 0);
      const idA = await insertPerson(eventId, sideA);
      const idB = await insertPerson(eventId, sideB);
      await clustering.dismissMergeSuggestion(eventId, idA, idB);
      await db('event_people').where({ id: idB }).del();

      // 0.65 to side A — above the 0.6 match threshold, so it would join A —
      // and 0.85 to side B, which is where it actually belongs.
      const face = new Float32Array(DIM);
      face[0] = 0.65; face[1] = 0.553; face[2] = Math.sqrt(1 - 0.65 ** 2 - 0.553 ** 2);

      const [p] = await db('photos').insert({
        event_id: eventId, filename: 'loose.jpg', path: '/tmp/l.jpg', type: 'individual',
      }).returning('id');
      const [f] = await db('photo_faces').insert({
        photo_id: typeof p === 'object' ? p.id : p, event_id: eventId,
        bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200, det_score: 0.99,
        embedding: clustering.packEmbedding(face), model_version: 'test-v1',
        created_at: new Date().toISOString(),
      }).returning('id');

      const assignments = await clustering.assignFaces(
        eventId, [{ id: typeof f === 'object' ? f.id : f, embedding: clustering.packEmbedding(face),
          model_version: 'test-v1', det_score: 0.99, bbox_w: 200, bbox_h: 200 }],
        { thresholds: THRESHOLDS },
      );

      expect(assignments[0].personId).not.toBe(idA);
      expect(assignments[0].personId).toBeTruthy();
    });

    it('binds while the clusters are still being rebuilt one face at a time', async () => {
      const eventId = await seedEvent('sep-assign-rebuild');
      // recluster() empties event_people and re-assigns from scratch, so for
      // the first faces of a batch the "person" on the other side of the
      // comparison is a cluster of ONE. A settled centroid it is not, and
      // holding it to the strict threshold meant the pair was already merged
      // by the time the constraint could bind — with nothing left to split it.
      const [sideA, sideB] = pairAtSimilarity(0.7, 0);
      const idA = await insertPerson(eventId, sideA);
      const idB = await insertPerson(eventId, sideB);
      await clustering.dismissMergeSuggestion(eventId, idA, idB);
      await db('event_people').where({ event_id: eventId }).del();

      // Two faces, one per side, each a little off its own side's centroid —
      // 0.91, just under the strict bar — and 0.66 to each other, over the
      // match threshold. Exactly the pair that must not re-form.
      const off = Math.sqrt(1 - 0.91 ** 2);
      const faceA = new Float32Array(DIM);
      faceA[0] = 0.91; faceA[3] = off;
      const faceB = new Float32Array(DIM);
      faceB[0] = 0.91 * 0.7; faceB[1] = 0.91 * Math.sqrt(1 - 0.7 ** 2); faceB[3] = off;

      const rows = [];
      for (const vec of [faceA, faceB]) {
        const [p] = await db('photos').insert({
          event_id: eventId, filename: `${Math.random()}.jpg`, path: '/tmp/r.jpg', type: 'individual',
        }).returning('id');
        const [f] = await db('photo_faces').insert({
          photo_id: typeof p === 'object' ? p.id : p, event_id: eventId,
          bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200, det_score: 0.99,
          embedding: clustering.packEmbedding(vec), model_version: 'test-v1',
          created_at: new Date().toISOString(),
        }).returning('id');
        rows.push({ id: typeof f === 'object' ? f.id : f, embedding: clustering.packEmbedding(vec),
          model_version: 'test-v1', det_score: 0.99, bbox_w: 200, bbox_h: 200 });
      }

      // The premise: they are close enough to each other to cluster together.
      expect(clustering.dot(faceA, faceB)).toBeGreaterThan(THRESHOLDS.face_match_threshold);

      const assignments = await clustering.assignFaces(eventId, rows, { thresholds: THRESHOLDS });
      expect(assignments[0].personId).not.toBe(assignments[1].personId);
    });

    it('leaves ordinary assignment alone when no separation applies', async () => {
      const eventId = await seedEvent('sep-assign-clean');
      const base = new Float32Array(DIM); base[0] = 1;
      const personId = await insertPerson(eventId, base);

      const [p] = await db('photos').insert({
        event_id: eventId, filename: 'x.jpg', path: '/tmp/x.jpg', type: 'individual',
      }).returning('id');
      const photoId = typeof p === 'object' ? p.id : p;
      const [f] = await db('photo_faces').insert({
        photo_id: photoId, event_id: eventId,
        bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200, det_score: 0.99,
        embedding: clustering.packEmbedding(base), model_version: 'test-v1',
        created_at: new Date().toISOString(),
      }).returning('id');

      const assignments = await clustering.assignFaces(
        eventId, [{ id: typeof f === 'object' ? f.id : f, embedding: clustering.packEmbedding(base),
          model_version: 'test-v1', det_score: 0.99, bbox_w: 200, bbox_h: 200 }],
        { thresholds: THRESHOLDS },
      );

      // The whole point of the strict threshold: a constraint that fires when
      // it should not would quietly wreck ordinary clustering.
      expect(assignments[0].personId).toBe(personId);
    });
  });
});
