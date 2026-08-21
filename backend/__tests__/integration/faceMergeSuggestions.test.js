/**
 * Automatic consolidation reporting and the suggestion band (#1107).
 *
 * Centroids are built to an EXACT cosine similarity rather than jittered
 * towards one, because every assertion here is about which side of a threshold
 * a pair falls on. `pairAtSimilarity` returns two unit vectors whose dot
 * product is the requested number to floating-point precision, and each pair
 * is built on its own orthogonal basis so two different pairs are never
 * accidentally similar to each other.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-facesuggest-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'facesuggest-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let clustering;

// Mirrors the service: merge at match + 0.08, so with a 0.60 floor the
// suggestion band is [0.60, 0.68).
const THRESHOLDS = {
  face_match_threshold: 0.6,
  face_quality_min_score: 0.7,
  face_quality_min_px: 40,
};

const DIM = 64;

/** Two unit vectors whose dot product is exactly `target`, on basis (i, i+1). */
function pairAtSimilarity(target, basis) {
  const a = new Float32Array(DIM);
  const b = new Float32Array(DIM);
  const orth = Math.sqrt(1 - target * target);
  a[basis] = 1;
  b[basis] = target;
  b[basis + 1] = orth;
  return [a, b];
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

async function insertPerson(eventId, centroid, overrides = {}) {
  const [row] = await db('event_people').insert({
    event_id: eventId,
    centroid: clustering.packEmbedding(centroid),
    face_count_total: 5,
    model_version: 'test-v1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

/** One person with one real face, so merge/split have something to move. */
async function insertPersonWithFace(eventId, centroid, overrides = {}) {
  const personId = await insertPerson(eventId, centroid, overrides);
  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: `${Math.random()}.jpg`,
    path: '/tmp/x.jpg',
    type: 'individual',
  }).returning('id');
  const photoId = typeof p === 'object' ? p.id : p;
  await db('photo_faces').insert({
    photo_id: photoId,
    event_id: eventId,
    person_id: personId,
    bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200,
    det_score: 0.99,
    embedding: clustering.packEmbedding(centroid),
    model_version: 'test-v1',
    created_at: new Date().toISOString(),
  });
  return personId;
}

/** An additional face on an existing person, so a split has something to move. */
async function addFaceTo(eventId, personId, centroid) {
  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: `${Math.random()}.jpg`,
    path: '/tmp/x.jpg',
    type: 'individual',
  }).returning('id');
  const photoId = typeof p === 'object' ? p.id : p;
  const [f] = await db('photo_faces').insert({
    photo_id: photoId,
    event_id: eventId,
    person_id: personId,
    bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200,
    det_score: 0.99,
    embedding: clustering.packEmbedding(centroid),
    model_version: 'test-v1',
    created_at: new Date().toISOString(),
  }).returning('id');
  return typeof f === 'object' ? f.id : f;
}

const suggest = (eventId) => clustering.suggestMerges(eventId, { thresholds: THRESHOLDS });

describe('face merge suggestions (#1107)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    clustering = require('../../src/services/faceClustering');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('the band', () => {
    it('suggests a pair between the match and auto-merge thresholds', async () => {
      const eventId = await seedEvent('band-inside');
      const [a, b] = pairAtSimilarity(0.64, 0);
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);

      const out = await suggest(eventId);

      expect(out).toHaveLength(1);
      expect([out[0].person_a_id, out[0].person_b_id].sort()).toEqual([idA, idB].sort());
      expect(out[0].score).toBeCloseTo(0.64, 4);
    });

    it('stays silent above the auto-merge threshold — consolidate() owns that pair', async () => {
      const eventId = await seedEvent('band-above');
      const [a, b] = pairAtSimilarity(0.75, 0);
      await insertPerson(eventId, a);
      await insertPerson(eventId, b);

      expect(await suggest(eventId)).toEqual([]);
    });

    it('stays silent below the match threshold — further apart than one face would join', async () => {
      const eventId = await seedEvent('band-below');
      const [a, b] = pairAtSimilarity(0.5, 0);
      await insertPerson(eventId, a);
      await insertPerson(eventId, b);

      expect(await suggest(eventId)).toEqual([]);
    });
  });

  describe('what it refuses to ask about', () => {
    it('never questions two people the photographer named differently', async () => {
      const eventId = await seedEvent('named-apart');
      const [a, b] = pairAtSimilarity(0.64, 0);
      await insertPerson(eventId, a, { label: 'Anna' });
      await insertPerson(eventId, b, { label: 'Beatrix' });

      expect(await suggest(eventId)).toEqual([]);
    });

    it('still asks when only one of the two is named', async () => {
      const eventId = await seedEvent('one-named');
      const [a, b] = pairAtSimilarity(0.64, 0);
      await insertPerson(eventId, a, { label: 'Anna' });
      await insertPerson(eventId, b);

      expect(await suggest(eventId)).toHaveLength(1);
    });

    it('skips a person marked "not a real person" — that answer was already given', async () => {
      const eventId = await seedEvent('ignored');
      const [a, b] = pairAtSimilarity(0.64, 0);
      await insertPerson(eventId, a);
      await insertPerson(eventId, b, { is_ignored: true });

      expect(await suggest(eventId)).toEqual([]);
    });

    it('never crosses embedding spaces', async () => {
      const eventId = await seedEvent('model-skew');
      const [a, b] = pairAtSimilarity(0.64, 0);
      await insertPerson(eventId, a);
      await insertPerson(eventId, b, { model_version: 'test-v2' });

      expect(await suggest(eventId)).toEqual([]);
    });
  });

  describe('dismissal', () => {
    it('stops suggesting a pair the photographer rejected, and survives a repeat', async () => {
      const eventId = await seedEvent('dismissal');
      const [a, b] = pairAtSimilarity(0.64, 0);
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);

      expect(await suggest(eventId)).toHaveLength(1);

      await clustering.dismissMergeSuggestion(eventId, idB, idA); // reversed on purpose
      expect(await suggest(eventId)).toEqual([]);

      // A second dismissal hits the UNIQUE constraint. Dismissing twice is a
      // double-click, not an error.
      await expect(clustering.dismissMergeSuggestion(eventId, idA, idB)).resolves.toEqual({
        dismissed: true,
      });
      expect(await suggest(eventId)).toEqual([]);
    });

    /**
     * The swallow-the-duplicate branch has to discriminate, because the failure
     * it must NOT swallow looks identical to the caller: returning
     * "kept separate" for a decision that was never written means the pair
     * silently comes back after the next scan.
     *
     * Tested on the predicate directly — provoking a read-only database or a
     * dropped table mid-suite would corrupt the shared fixture for every other
     * case in this file.
     */
    it.each([
      ['postgres unique violation', { code: '23505', message: 'duplicate key value violates unique constraint' }, true],
      ['sqlite3 unique violation', { code: 'SQLITE_CONSTRAINT', message: 'UNIQUE constraint failed: event_people_merge_dismissals.event_id' }, true],
      ['better-sqlite3 unique violation', { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed' }, true],
      ['sqlite foreign-key violation', { code: 'SQLITE_CONSTRAINT', message: 'FOREIGN KEY constraint failed' }, false],
      ['sqlite busy', { code: 'SQLITE_BUSY', message: 'database is locked' }, false],
      ['missing table', { code: 'SQLITE_ERROR', message: 'no such table: event_people_merge_dismissals' }, false],
      ['postgres read-only transaction', { code: '25006', message: 'cannot execute INSERT in a read-only transaction' }, false],
      ['no error at all', null, false],
    ])('%s → swallowed: %s', (_name, err, expected) => {
      expect(clustering.isUniqueViolation(err)).toBe(expected);
    });

    /**
     * The dismissal read is the only thing standing between the automatic pass
     * and a pair the photographer explicitly separated. If it fails open, a
     * timeout silently restores the merge that "Not the same" was supposed to
     * prevent — so anything other than a missing table must stop the pass.
     */
    it('refuses to consolidate when the dismissal list cannot be read', async () => {
      const eventId = await seedEvent('dismissals-unreadable');
      // Well above the auto-merge threshold, so only a refusal keeps them apart.
      const [a, b] = pairAtSimilarity(0.97, 0);
      await insertPersonWithFace(eventId, a);
      await insertPersonWithFace(eventId, b);

      // Break the read for real rather than mocking knex: dropping a selected
      // column makes the query fail with something that is NOT "missing
      // table", which is exactly the class that must not fail open.
      await db.schema.alterTable('event_people_merge_dismissals', (t) => t.dropColumn('person_b_id'));
      try {
        await expect(clustering.consolidate(eventId, { thresholds: THRESHOLDS }))
          .rejects.toThrow();

        // Nothing merged: the pass gave up rather than overriding a decision
        // it could not read.
        expect(await db('event_people').where({ event_id: eventId })).toHaveLength(2);
      } finally {
        await db.schema.alterTable('event_people_merge_dismissals', (t) => {
          t.integer('person_b_id').notNullable().defaultTo(0);
        });
      }
    });

    it.each([
      ['postgres undefined_table', { code: '42P01', message: 'relation "x" does not exist' }, true],
      ['sqlite missing table', { code: 'SQLITE_ERROR', message: 'no such table: x' }, true],
      // The one that matters: a missing COLUMN is a broken query, not a
      // pre-migration install, and must NOT be allowed to fail open.
      ['postgres undefined_column', { code: '42703', message: 'column "x" does not exist' }, false],
      ['sqlite missing column', { code: 'SQLITE_ERROR', message: 'no such column: x' }, false],
      ['statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }, false],
    ])('missing-table check — %s → %s', (_name, err, expected) => {
      expect(clustering.isMissingTable(err)).toBe(expected);
    });

    it('normalizes the pair so one row covers both orderings', async () => {
      const eventId = await seedEvent('dismissal-normalized');
      const [a, b] = pairAtSimilarity(0.64, 0);
      const idA = await insertPerson(eventId, a);
      const idB = await insertPerson(eventId, b);

      await clustering.dismissMergeSuggestion(eventId, idB, idA);
      const rows = await db('event_people_merge_dismissals').where({ event_id: eventId });

      expect(rows).toHaveLength(1);
      expect(rows[0].person_a_id).toBe(Math.min(idA, idB));
      expect(rows[0].person_b_id).toBe(Math.max(idA, idB));
    });
  });

  describe('one suggestion per person per round', () => {
    it('does not offer A-B, A-C and B-C for a three-way fragment', async () => {
      const eventId = await seedEvent('three-way');
      // Three mutually similar centroids, all inside the band.
      const base = new Float32Array(DIM); base[0] = 1;
      const people = [];
      for (let k = 0; k < 3; k++) {
        const v = new Float32Array(DIM);
        v[0] = 0.9;
        v[1 + k] = Math.sqrt(1 - 0.81);
        people.push(await insertPerson(eventId, v));
      }
      await insertPerson(eventId, base);

      const out = await suggest(eventId);

      // Every returned pair must name people not already spoken for: accepting
      // the first suggestion must never leave a second one pointing at a person
      // that the merge just deleted.
      const seen = new Set();
      for (const s of out) {
        expect(seen.has(s.person_a_id)).toBe(false);
        expect(seen.has(s.person_b_id)).toBe(false);
        seen.add(s.person_a_id);
        seen.add(s.person_b_id);
      }
    });

    it('offers the most similar pair first', async () => {
      const eventId = await seedEvent('ordering');
      const [a1, b1] = pairAtSimilarity(0.62, 0);
      const [a2, b2] = pairAtSimilarity(0.67, 10);
      await insertPerson(eventId, a1);
      await insertPerson(eventId, b1);
      await insertPerson(eventId, a2);
      await insertPerson(eventId, b2);

      const out = await suggest(eventId);

      expect(out).toHaveLength(2);
      expect(out[0].score).toBeGreaterThan(out[1].score);
    });
  });

  describe('manual splits survive the automatic pass', () => {
    /**
     * The regression that matters most once consolidation runs on every scan:
     * a photographer splitting a wrongly-merged cluster produces two people
     * who are look-alikes BY CONSTRUCTION, so their centroids sit above the
     * merge threshold and the very next scan would put them straight back.
     */
    it('records a split as a separation, so consolidation leaves it alone', async () => {
      const eventId = await seedEvent('split-protected');
      const base = new Float32Array(DIM); base[0] = 1;

      // One cluster holding two near-identical faces.
      const personId = await insertPersonWithFace(eventId, base);
      const extraFaceId = await addFaceTo(eventId, personId, base);

      const newPersonId = await clustering.splitPerson(eventId, personId, [extraFaceId]);
      expect(newPersonId).toBeTruthy();

      const rows = await db('event_people_merge_dismissals').where({ event_id: eventId });
      expect(rows).toHaveLength(1);
      expect([rows[0].person_a_id, rows[0].person_b_id].sort())
        .toEqual([personId, newPersonId].sort());

      // Identical centroids — nothing but the recorded separation can stop
      // this merge.
      const merged = await clustering.consolidate(eventId, { thresholds: THRESHOLDS });
      expect(merged).toEqual([]);
      expect(await db('event_people').where({ event_id: eventId })).toHaveLength(2);
    });
  });

  describe('consolidation reporting', () => {
    it('records what an automatic pass merged, so it is not silent', async () => {
      const eventId = await seedEvent('report-merged');
      // 0.97 is above the 0.68 auto-merge threshold — consolidate() acts.
      const [a, b] = pairAtSimilarity(0.97, 0);
      await insertPersonWithFace(eventId, a);
      await insertPersonWithFace(eventId, b);

      const merged = await clustering.consolidate(eventId, { thresholds: THRESHOLDS });
      expect(merged).toHaveLength(1);

      const event = await db('events').where({ id: eventId }).first();
      expect(Number(event.faces_last_consolidated_count)).toBe(1);
      expect(event.faces_last_consolidated_at).toBeTruthy();
    });

    it('never absorbs an ignored cluster — that would mark a real person ignored', async () => {
      const eventId = await seedEvent('consolidate-ignored');
      // Well above the auto-merge threshold: only the is_ignored flag can
      // stop this pair.
      const [a, b] = pairAtSimilarity(0.97, 0);
      const real = await insertPersonWithFace(eventId, a);
      const junk = await insertPersonWithFace(eventId, b, { is_ignored: true });

      const merged = await clustering.consolidate(eventId, { thresholds: THRESHOLDS });

      expect(merged).toEqual([]);
      // Both still standing, and the real person is still guest-visible —
      // mergePeople ORs is_ignored onto the survivor, so absorbing the junk
      // cluster would have hidden a real person from the gallery.
      const survivors = await db('event_people').where({ event_id: eventId }).select('id', 'is_ignored');
      expect(survivors.map((p) => p.id).sort()).toEqual([real, junk].sort());
      const realRow = survivors.find((p) => p.id === real);
      expect(realRow.is_ignored === true || realRow.is_ignored === 1).toBe(false);
    });

    it('never merges a pair the photographer said was not the same person', async () => {
      const eventId = await seedEvent('consolidate-dismissed');
      // Also above the auto-merge threshold: the dismissal is the only thing
      // standing between these two, which is the point — a human "no" has to
      // outrank the automatic pass, not just the suggestion list.
      const [a, b] = pairAtSimilarity(0.97, 0);
      const idA = await insertPersonWithFace(eventId, a);
      const idB = await insertPersonWithFace(eventId, b);

      await clustering.dismissMergeSuggestion(eventId, idA, idB);
      const merged = await clustering.consolidate(eventId, { thresholds: THRESHOLDS });

      expect(merged).toEqual([]);
      expect(await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first())
        .toEqual(expect.objectContaining({ c: 2 }));
    });

    // NOT covered by a test: reporting what a pass merged before it died
    // partway. `consolidate` calls `mergePeople` through the module-local
    // binding, so a spy on the export cannot intercept it, and no realistic
    // database failure lands on the second merge only. The recording therefore
    // sits in a `finally` — each mergePeople is its own transaction, so a pass
    // that throws has still committed what it did, and the alternative is a
    // real merge going unreported. Verified by reading, not by assertion.

    it('clears a previous count when a later pass merges nothing', async () => {
      const eventId = await seedEvent('report-cleared');
      await db('events').where({ id: eventId }).update({ faces_last_consolidated_count: 7 });

      const [a, b] = pairAtSimilarity(0.5, 0);
      await insertPersonWithFace(eventId, a);
      await insertPersonWithFace(eventId, b);

      await clustering.consolidate(eventId, { thresholds: THRESHOLDS });

      const event = await db('events').where({ id: eventId }).first();
      expect(Number(event.faces_last_consolidated_count)).toBe(0);
    });
  });
});
