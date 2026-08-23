/**
 * Per-event face clustering (#1074).
 *
 * Plain JS over a few thousand rows. A gallery is hundreds to low-thousands
 * of faces, so this needs no vector database and no native extension — the
 * embeddings live in a BLOB column and the maths is a dot product.
 *
 * Algorithm: greedy incremental assignment. A new face is compared against
 * every existing person centroid in the event; above the match threshold it
 * joins the nearest one and updates that centroid as a running mean,
 * otherwise it opens a new person.
 *
 * Greedy assignment is order-dependent by construction — the same photos
 * uploaded in a different order can produce different clusters. That is
 * accepted here (it is what Immich, PhotoPrism and Ente all do) and mitigated
 * by `consolidate()`, which merges centroid pairs that have drifted together,
 * plus the admin merge/split tools. What it buys is that a photo can be
 * clustered the moment it is scanned, so the strip fills in during a backfill
 * instead of after it.
 *
 * Embeddings arrive L2-normalized from the sidecar, so cosine similarity is a
 * plain dot product. Centroids are re-normalized after every update to keep
 * that true.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getThresholds } = require('./faceSettings');

const FLOAT_BYTES = 4;

// -- serialization -----------------------------------------------------------

/**
 * Float32Array → Buffer for the BLOB column. Little-endian on every platform
 * we ship (x86_64, aarch64), and the value never leaves the deployment, so
 * no byte-order header is needed.
 */
function packEmbedding(vec) {
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function unpackEmbedding(buf) {
  if (!buf) return null;
  // Postgres bytea comes back as Buffer; SQLite may hand back a Uint8Array.
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length % FLOAT_BYTES !== 0) return null;
  // Copy rather than aliasing: a Buffer from the driver may be a view into a
  // larger pooled allocation, and Float32Array over an unaligned offset
  // throws.
  const copy = Buffer.from(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / FLOAT_BYTES);
}

// -- vector maths ------------------------------------------------------------

function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Running mean of `count` existing vectors with one new vector, re-normalized.
 */
function updateCentroid(centroid, count, incoming) {
  const out = new Float32Array(centroid.length);
  for (let i = 0; i < centroid.length; i++) {
    out[i] = (centroid[i] * count + incoming[i]) / (count + 1);
  }
  return normalize(out);
}

// -- quality -----------------------------------------------------------------

/**
 * Is this face good enough to define a person?
 *
 * Low-quality faces are still STORED and still shown in "this photo contains"
 * — they just don't get assigned, so they can't spawn junk people or drag a
 * good centroid off course. A blurry profile at 30px is a real detection and
 * a terrible identity.
 */
function meetsQualityFloor(face, thresholds) {
  if (face.det_score != null && face.det_score < thresholds.face_quality_min_score) return false;
  const size = Math.min(face.bbox_w ?? 0, face.bbox_h ?? 0);
  if (size < thresholds.face_quality_min_px) return false;
  return true;
}

// -- clustering --------------------------------------------------------------

/**
 * Assign a set of freshly-inserted faces to people within one event.
 *
 * Loads the event's people once, mutates centroids in memory across the whole
 * batch, then writes back — so a photo with five faces costs one read and one
 * write pass rather than five of each.
 */
/**
 * Per-event serialization for cluster assignment.
 *
 * assignFaces is read-modify-write over an event's people: it loads every
 * centroid, mutates them in memory across the batch, then writes back. Two
 * workers on the same event therefore lose updates — both read the same
 * snapshot, and the second write clobbers the first (or both open a duplicate
 * person for the same face). The default concurrency is 1, but the queue
 * advertises multi-pod safety and the tunable exists, so this cannot rely on
 * there only ever being one writer.
 *
 * In-process mutex + (on Postgres) a transaction-scoped advisory lock keyed on
 * the event. The advisory lock is what covers multiple pods; the mutex avoids
 * pointless lock round-trips within one process. SQLite is single-writer
 * anyway, so the mutex alone is sufficient there.
 */
const eventLocks = new Map();

async function withEventLock(eventId, trx, fn) {
  const previous = eventLocks.get(eventId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  eventLocks.set(eventId, previous.then(() => current));

  await previous;
  try {
    // pg_advisory_xact_lock is released automatically when the transaction
    // ends, including on rollback — no leak if the caller throws.
    if (trx && typeof trx.raw === 'function') {
      const client = db.client.config.client;
      const isPg = client === 'pg' || (typeof client === 'string' && client.includes('postgres'));
      if (isPg) {
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [1074, Number(eventId)]);
      }
    }
    return await fn();
  } finally {
    release();
    if (eventLocks.get(eventId) === current) eventLocks.delete(eventId);
  }
}

async function assignFaces(eventId, faceRows, options = {}) {
  const thresholds = options.thresholds || (await getThresholds());
  const trx = options.trx || db;

  return withEventLock(eventId, options.trx, () => assignFacesLocked(eventId, faceRows, thresholds, trx));
}

async function assignFacesLocked(eventId, faceRows, thresholds, trx) {
  const people = await trx('event_people')
    .where({ event_id: eventId })
    .select('id', 'centroid', 'face_count_total', 'model_version');

  const state = people.map((p) => ({
    id: p.id,
    centroid: unpackEmbedding(p.centroid),
    count: p.face_count_total || 0,
    dirty: false,
    modelVersion: p.model_version,
  })).filter((p) => p.centroid);

  // Loaded once for the whole batch rather than per face: a photo with five
  // faces would otherwise re-read the same handful of rows five times, and a
  // backfill does that for every photo in the gallery.
  // Through the caller's trx, not the global db: assignFaces runs inside
  // processPhotoFaces' transaction, and on SQLite a second connection reading
  // while that write transaction is open can block on the writer lock.
  const { vectors: allSeparations } = await loadSeparations(eventId, trx);

  // Narrow to the separations this batch could possibly trip, before anything
  // is projected. A separation binds only if the incoming FACE resolves to one
  // of its sides, so if no face in the batch clears the threshold against
  // either side, that separation cannot fire here — dropping it is exactly
  // equivalent, not an approximation.
  //
  // This is what keeps a full scan affordable. assignFaces runs once per PHOTO,
  // so projecting every person against every separation on every call would
  // reintroduce the O(photos·people·separations·dims) cost the projection hoist
  // just removed. One pass over the handful of vectors in this photo decides
  // whether the event's people need projecting at all, and for almost every
  // photo the answer is no.
  const batchVectors = faceRows.map((f) => unpackEmbedding(f.embedding)).filter(Boolean);
  const separations = allSeparations.filter((sep) => batchVectors.some(
    (v) => dot(v, sep.a) >= thresholds.face_match_threshold
      || dot(v, sep.b) >= thresholds.face_match_threshold,
  ));

  for (const person of state) person.sep = projectOnSeparations(person.centroid, separations);

  const assignments = [];

  for (const face of faceRows) {
    const embedding = unpackEmbedding(face.embedding);
    if (!embedding) continue;

    if (!meetsQualityFloor(face, thresholds)) {
      assignments.push({ faceId: face.id, personId: null });
      continue;
    }

    const faceSep = projectOnSeparations(embedding, separations);

    let best = null;
    let bestScore = -Infinity;
    for (const person of state) {
      // Never compare across embedding spaces — a model change makes old
      // centroids meaningless rather than merely stale.
      if (person.modelVersion && face.model_version && person.modelVersion !== face.model_version) {
        continue;
      }
      // Honour the photographer's separations here, not only in consolidate()
      // (#1132). Without this the constraint was toothless across a re-scan:
      // the faces come back with new ids, assignment puts them wherever the
      // maths says, and the pair the photographer pulled apart is reformed
      // before any later pass gets to object — a dismissed pair scores at
      // least face_match_threshold by definition, that being the bottom of the
      // suggestion band.
      //
      // Skipping a candidate can push a face to its SECOND-nearest centroid,
      // or open a new person. That is the intended cost: a human said these
      // are different people, and the alternative is silently overruling them.
      // The threshold is strict enough that this only fires while the cluster
      // still looks like the one that was separated.
      if (separationForbidsProjected(faceSep, person.sep, {
        modelVersion: face.model_version || person.modelVersion || null,
        // BOTH sides get the ordinary match threshold here, not the strict
        // one. Neither side of this comparison is a settled centroid: the
        // candidate is a single face, and during a recluster the "person" it
        // is being compared against is often a cluster of one — state starts
        // empty and is rebuilt face by face. Holding either to 0.92 meant the
        // constraint could not bind until well after the merge it was supposed
        // to prevent had already happened. consolidate() and suggestMerges()
        // keep the strict threshold, because there both sides really are
        // established centroids.
        threshold: thresholds.face_match_threshold,
      })) {
        continue;
      }
      const score = dot(embedding, person.centroid);
      if (score > bestScore) {
        bestScore = score;
        best = person;
      }
    }

    if (best && bestScore >= thresholds.face_match_threshold) {
      best.centroid = updateCentroid(best.centroid, best.count, embedding);
      best.count += 1;
      best.dirty = true;
      // The centroid just moved, so its projection is stale — one re-project
      // per ASSIGNED face, not per comparison.
      best.sep = projectOnSeparations(best.centroid, separations);
      assignments.push({ faceId: face.id, personId: best.id });
    } else {
      const [inserted] = await trx('event_people').insert({
        event_id: eventId,
        centroid: packEmbedding(embedding),
        face_count_total: 1,
        model_version: face.model_version,
        // cover_face_id is deliberately NOT set (#1096). It means one thing
        // now — the photographer picked this face — and seeding it with
        // whichever face happened to start the cluster made that
        // indistinguishable from a real choice. listPeople derives the
        // automatic cover at read time instead, which it has to anyway: the
        // best face for an ADMIN may sit in a photo a guest cannot open.
        cover_face_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const personId = typeof inserted === 'object' ? inserted.id : inserted;

      state.push({
        id: personId,
        centroid: embedding,
        count: 1,
        dirty: false,
        modelVersion: face.model_version,
        sep: faceSep,
      });
      assignments.push({ faceId: face.id, personId });
    }
  }

  for (const { faceId, personId } of assignments) {
    await trx('photo_faces').where({ id: faceId }).update({ person_id: personId });
  }

  for (const person of state) {
    if (!person.dirty) continue;
    await trx('event_people').where({ id: person.id }).update({
      centroid: packEmbedding(person.centroid),
      face_count_total: person.count,
      updated_at: new Date().toISOString(),
    });
  }

  return assignments;
}

/**
 * Does this error mean the table isn't there yet, as opposed to the query
 * failing? Postgres reports SQLSTATE 42P01; SQLite says so in the message.
 * The distinction decides whether a dismissal read may fail open.
 */
function isMissingTable(err) {
  if (!err) return false;
  // Postgres: undefined_table. Deliberately NOT matched on the message — its
  // "does not exist" wording also covers a missing COLUMN, which is a broken
  // query rather than a pre-migration install and must not fail open.
  if (err.code === '42P01') return true;
  return /no such table/i.test(err.message || '');
}

/**
 * One identity for a pair regardless of which order it was produced in.
 * Rows are stored the same way, so the two always agree.
 */
function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * How closely a cluster must still resemble a separated side for the
 * separation to bind it (#1132).
 *
 * Deliberately stricter than the auto-merge threshold. This is not asking "are
 * these the same person" but "is this still the same CLUSTER the photographer
 * pointed at" — a much narrower claim, and one that should lapse once the
 * cluster has been reshaped enough that the original decision may no longer
 * reflect what is in it.
 */
const SEPARATION_MATCH_THRESHOLD = 0.92;

/**
 * One vector's similarity to both sides of every separation.
 *
 * Hoisted out of the comparison so the maths is paid per VECTOR, not per pair.
 * separationForbids is called from the innermost loop of assignment (every face
 * against every person) and of consolidation (every person against every other)
 * — projecting inside it made those O(F·P·S·D) and O(P²·S·D), which on a
 * gallery with a few hundred people and a handful of dismissals is billions of
 * float operations per re-scan. Projecting once per vector makes it
 * O((F+P)·S·D) of arithmetic plus O(S) scalar comparisons per pair, which is
 * the same order as the clustering it is guarding.
 */
function projectOnSeparations(vec, separations) {
  if (!vec || !separations?.length) return [];
  const out = [];
  for (const sep of separations) {
    if (!sep.a || !sep.b) continue;
    out.push({ a: dot(vec, sep.a), b: dot(vec, sep.b), modelVersion: sep.modelVersion || null });
  }
  return out;
}

/**
 * Does a stored separation forbid putting these two vectors together?
 *
 * A separation binds when each of its two sides still matches one of the
 * candidates — in either orientation, since neither the stored pair nor the
 * candidate pair has a meaningful order.
 *
 * `modelVersion` is the space the two candidates live in; every caller has
 * already refused to compare across spaces before reaching here. A separation
 * recorded under a different model is skipped for the same reason: its vectors
 * are meaningless there, not merely stale.
 *
 * `threshold` is how closely a side must still be matched. It is the caller's
 * because it depends on what is being compared: settled centroids can be held
 * to SEPARATION_MATCH_THRESHOLD, whereas a single face — or a cluster of one
 * part-way through a recluster — sits well below its own centroid and has to be
 * judged at the ordinary match threshold. Holding those to 0.92 let exactly the
 * case this feature exists for through.
 *
 * Takes PROJECTIONS, not vectors — see projectOnSeparations. The two arrays are
 * positionally aligned because both come from the same separation list.
 */
function separationForbidsProjected(projX, projY, options = {}) {
  const { modelVersion = null, threshold = SEPARATION_MATCH_THRESHOLD } = options;
  if (!projX?.length || !projY?.length) return false;

  for (let i = 0; i < projX.length; i++) {
    const px = projX[i];
    const py = projY[i];
    if (!px || !py) continue;
    if (modelVersion && px.modelVersion && px.modelVersion !== modelVersion) continue;

    const xa = px.a;
    const xb = px.b;
    const ya = py.a;
    const yb = py.b;

    // Each candidate must resolve to ONE side and the other candidate to the
    // OTHER. Clearing the bar against both sides independently is not enough,
    // and getting that wrong is not a corner case: a split leaves two halves
    // that came out of one cluster, so its two stored sides are often similar
    // to each other. Under the looser test, two faces that are plainly the
    // SAME side each cleared the threshold against both — so the person the
    // split was not even about got forbidden from clustering with itself and
    // fragmented into singletons.
    //
    // Requiring a strict preference also makes the constraint lapse exactly
    // when it becomes meaningless: if the two stored sides are so alike that a
    // candidate cannot be told apart between them, there is no "these two" left
    // to enforce.
    const straight = xa >= threshold && yb >= threshold && xa > xb && yb > ya;
    const crossed = xb >= threshold && ya >= threshold && xb > xa && ya > yb;
    if (straight || crossed) return true;
  }
  return false;
}

/**
 * Vector-level convenience wrapper. Fine for one-off checks; the hot loops
 * project once and call separationForbidsProjected directly.
 */
function separationForbids(vecX, vecY, separations, options = {}) {
  if (!vecX || !vecY) return false;
  return separationForbidsProjected(
    projectOnSeparations(vecX, separations),
    projectOnSeparations(vecY, separations),
    options,
  );
}

/**
 * Pairs the photographer has explicitly kept apart (#1107, #1132).
 *
 * Read by BOTH the automatic pass and the suggestion list: "not the same
 * person" has to bind the thing that acts on its own even more than it binds
 * the thing that asks. Missing table (pre-migration) reads as "nothing
 * dismissed" rather than failing the merge that called this.
 *
 * Returns both identities. `ids` is the exact person-id pair set, valid only
 * while those ids still mean what they meant — cheap and unambiguous within one
 * clustering cycle. `vectors` is what survives re-derivation: person ids die on
 * a recluster and face ids die on a full re-scan, so the embeddings are the only
 * stable handle on "these two".
 *
 * Every row is returned carrying its own model_version rather than the load
 * being filtered to one. recluster() hands the whole event to assignFaces in a
 * single batch, and a partial upgrade or a failed re-scan can leave faces from
 * two models in it — filtering on the first face's model would silently drop
 * every separation belonging to the others.
 */
async function loadSeparations(eventId, conn = db) {
  try {
    const rows = await conn('event_people_merge_dismissals')
      .where({ event_id: eventId })
      .select('person_a_id', 'person_b_id', 'centroid_a', 'centroid_b', 'model_version');

    const ids = new Set();
    const vectors = [];
    for (const row of rows) {
      ids.add(pairKey(row.person_a_id, row.person_b_id));
      // Never compare across embedding spaces — a model change makes a stored
      // centroid meaningless rather than merely stale, the same rule assignment
      // and consolidation already apply to event_people.centroid.
      const a = unpackEmbedding(row.centroid_a);
      const b = unpackEmbedding(row.centroid_b);
      if (a && b) vectors.push({ a, b, modelVersion: row.model_version || null });
    }
    return { ids, vectors };
  } catch (err) {
    // ONLY a missing table reads as "nothing dismissed" — that is a
    // pre-migration install, where by definition nothing has been dismissed.
    //
    // Everything else FAILS CLOSED. Treating a timeout or a permission error
    // as an empty set would let the automatic pass merge pairs the
    // photographer explicitly separated, which is precisely the decision this
    // set exists to protect. The caller defers instead: drainConsolidation
    // backs the event off and retries.
    if (!isMissingTable(err)) throw err;
    logger.warn(
      `faceClustering: merge-dismissal table absent for event ${eventId} — treating as none`,
      { error: err.message }
    );
    return { ids: new Set(), vectors: [] };
  }
}

/**
 * Merge people whose centroids have drifted together.
 *
 * Greedy assignment can open "Anna in daylight" and "Anna at the party" as
 * two clusters when the first few photos of each were dissimilar. Once both
 * have absorbed enough faces their centroids converge, and this pass catches
 * that. Runs at a slightly stricter threshold than initial assignment:
 * merging two established clusters is a bigger claim than adding one face to
 * one of them, and an over-eager merge is much harder for a photographer to
 * unpick than a missed one.
 */
async function consolidate(eventId, options = {}) {
  const thresholds = options.thresholds || (await getThresholds());
  const mergeThreshold = Math.min(0.95, thresholds.face_match_threshold + 0.08);

  const people = await db('event_people')
    .where({ event_id: eventId })
    .select('id', 'centroid', 'face_count_total', 'model_version', 'label', 'is_ignored');

  const state = people
    // "Not a real person" must never be merged INTO one. mergePeople ORs
    // is_ignored onto the survivor, so absorbing a false-positive cluster
    // would mark a real person ignored and drop them out of the guest-facing
    // strip entirely. Cheap to skip, expensive to discover.
    .filter((p) => !(p.is_ignored === true || p.is_ignored === 1))
    .map((p) => ({ ...p, vec: unpackEmbedding(p.centroid) }))
    .filter((p) => p.vec);

  // A pair the photographer answered "not the same" about stays not the same,
  // however far the centroids drift afterwards. Without this the automatic
  // pass silently overturns an explicit human decision the moment new faces
  // push the pair over the threshold — or the moment someone tunes it.
  const separations = await loadSeparations(eventId);
  for (const p of state) p.sep = projectOnSeparations(p.vec, separations.vectors);

  const merged = [];
  const absorbed = new Set();

  // Each mergePeople is its own transaction, so a pass that dies halfway has
  // still committed what it did. Reporting has to survive that: recorded in a
  // finally, or a failure on the second pair would leave the first one merged
  // and unreported — silent, which is the one thing this must never be. The
  // retry then re-reports against whatever is left.
  try {
    for (let i = 0; i < state.length; i++) {
      if (absorbed.has(state[i].id)) continue;
      for (let j = i + 1; j < state.length; j++) {
        if (absorbed.has(state[j].id)) continue;
        const a = state[i];
        const b = state[j];
        if (a.model_version !== b.model_version) continue;

        // Never silently merge two people the photographer has NAMED
        // differently — that is a human assertion this heuristic does not get
        // to overrule.
        if (a.label && b.label && a.label !== b.label) continue;

        // Both identities: the exact pair while the ids still mean what they
        // meant, and the embedding match that carries the decision across a
        // re-derivation (#1132).
        if (separations.ids.has(pairKey(a.id, b.id))) continue;
        if (separationForbidsProjected(a.sep, b.sep,
          { modelVersion: a.model_version || null })) continue;

        if (dot(a.vec, b.vec) >= mergeThreshold) {
          // Re-read this one pair immediately before acting. The set above was
          // loaded once for the whole pass, and a photographer pressing "Not
          // the same" during it would otherwise be overruled by a decision that
          // was already stale when it was made. Narrows the window to a single
          // statement rather than the length of the pass; one extra query per
          // pair that is actually about to merge, which is rare.
          const justDismissed = await db('event_people_merge_dismissals')
            .where({
              event_id: eventId,
              person_a_id: Math.min(a.id, b.id),
              person_b_id: Math.max(a.id, b.id),
            })
            .first()
            .catch((err) => {
              if (isMissingTable(err)) return null;
              throw err;
            });
          if (justDismissed) continue;

          await mergePeople(eventId, [b.id], a.id);
          absorbed.add(b.id);
          merged.push({ from: b.id, into: a.id });
        }
      }
    }

  } finally {
    if (merged.length) {
      logger.info(`faceClustering: consolidated ${merged.length} person pair(s) in event ${eventId}`);
    }

    // Record the outcome even when it is zero. Merging biometric clusters
    // silently is the wrong default however confident the maths is (#1107), so
    // the admin card reports what this pass did — and a run that merged nothing
    // has to clear a previous run's count rather than leave it standing.
    await db('events').where({ id: eventId }).update({
      faces_last_consolidated_count: merged.length,
      faces_last_consolidated_at: new Date().toISOString(),
    }).catch((err) => {
      // Pre-migration installs simply do not report. Never let bookkeeping fail
      // a merge that already happened.
      logger.warn(`faceClustering: could not record consolidation for event ${eventId}`, {
        error: err.message,
      });
    });
  }

  return merged;
}

/**
 * Pairs that look like the same person but not confidently enough to merge
 * automatically (#1107).
 *
 * The band is [match_threshold, merge_threshold): above the top of it
 * `consolidate()` has already merged the pair, and below the bottom the two
 * centroids are further apart than the distance at which a single face would
 * have joined the cluster at all — which is not a claim worth putting in front
 * of anyone.
 *
 * This is the "with a warning" half of the request. An over-eager merge is much
 * harder to unpick than a missed one, so the uncertain band never merges by
 * itself; it asks.
 */
async function suggestMerges(eventId, options = {}) {
  const thresholds = options.thresholds || (await getThresholds());
  const mergeThreshold = Math.min(0.95, thresholds.face_match_threshold + 0.08);
  const floor = thresholds.face_match_threshold;
  const limit = options.limit || 20;

  const people = await db('event_people')
    .where({ event_id: eventId })
    .select('id', 'centroid', 'face_count_total', 'model_version', 'label', 'is_ignored');

  const state = people
    // "Not a real person" is an answer already given — never ask about it again.
    .filter((p) => !(p.is_ignored === true || p.is_ignored === 1))
    .map((p) => ({ ...p, vec: unpackEmbedding(p.centroid) }))
    .filter((p) => p.vec);

  if (state.length < 2) return [];

  const separations = await loadSeparations(eventId);
  for (const p of state) p.sep = projectOnSeparations(p.vec, separations.vectors);

  const pairs = [];
  for (let i = 0; i < state.length; i++) {
    for (let j = i + 1; j < state.length; j++) {
      const a = state[i];
      const b = state[j];
      if (a.model_version !== b.model_version) continue;
      // Same rule consolidate() applies: two different names is a human
      // assertion, not a question.
      if (a.label && b.label && a.label !== b.label) continue;

      // Exact pair while the ids still hold, plus the embedding match that
      // carries the decision across a re-derivation (#1132).
      if (separations.ids.has(pairKey(a.id, b.id))) continue;
      if (separationForbidsProjected(a.sep, b.sep,
        { modelVersion: a.model_version || null })) continue;

      const score = dot(a.vec, b.vec);
      if (score < floor || score >= mergeThreshold) continue;

      pairs.push({
        person_a_id: Math.min(a.id, b.id),
        person_b_id: Math.max(a.id, b.id),
        score,
      });
    }
  }

  // Most-similar first: the strongest suggestion is the one most likely to be
  // accepted, and a photographer working down the list should meet it first.
  pairs.sort((x, y) => y.score - x.score);

  // One suggestion per person per round. Without this a cluster that genuinely
  // has three fragments produces A-B, A-C and B-C, and accepting A-B leaves two
  // suggestions pointing at a person that no longer exists.
  const used = new Set();
  const result = [];
  for (const pair of pairs) {
    if (used.has(pair.person_a_id) || used.has(pair.person_b_id)) continue;
    used.add(pair.person_a_id);
    used.add(pair.person_b_id);
    result.push(pair);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Is this the UNIQUE constraint firing, as opposed to a real write failure?
 *
 * Both engines have to be recognised: Postgres reports SQLSTATE 23505, and
 * sqlite3 reports SQLITE_CONSTRAINT with the specific constraint named in the
 * message (better-sqlite3 narrows the code itself). Matching too broadly here
 * would put us back to swallowing genuine failures.
 */
function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    return /unique/i.test(err.message || '');
  }
  return false;
}

/**
 * The centroids of two people, packed for storage on a separation row (#1132).
 *
 * Best-effort: a pre-migration install has no columns to write, and a person
 * that vanished between the click and this read leaves the row keyed on ids
 * alone — which is exactly what it was before, so the decision is no worse off
 * than it used to be.
 */
async function separationSnapshot(eventId, personAId, personBId, conn = db) {
  try {
    const people = await conn('event_people')
      .where({ event_id: eventId })
      .whereIn('id', [personAId, personBId])
      .select('id', 'centroid', 'model_version');
    const a = people.find((p) => p.id === personAId);
    const b = people.find((p) => p.id === personBId);
    if (!a?.centroid || !b?.centroid) return {};
    return {
      centroid_a: a.centroid,
      centroid_b: b.centroid,
      model_version: a.model_version || b.model_version || null,
    };
  } catch (err) {
    logger.warn(`faceClustering: could not snapshot separation ${personAId}/${personBId}`, {
      error: err.message,
    });
    return {};
  }
}

/**
 * Re-anchor every separation in an event onto the people that are actually
 * there, and drop the ones that no longer describe anything (#1132).
 *
 * Called after faces are destroyed — a hard photo delete recomputes or removes
 * whole clusters. Two things have to happen, and neither can be decided from
 * the person ids: a row that has already outlived a recluster names people who
 * no longer exist, which is the normal state for this table rather than an
 * exceptional one.
 *
 *   1. Each side is re-snapshotted from the live cluster that best matches it.
 *      The stored vector is a COPY of a centroid, so after a purge it is the
 *      one place a vector derived from the deleted photo would survive. Taking
 *      it from a live centroid means it only ever describes photos that are
 *      still here.
 *
 *   2. A side that matches NO live person means the row is inert — the
 *      constraint requires a candidate to match a side, so nothing can ever
 *      trip it again — and it is deleted. That is what bounds retention: an
 *      abandoned snapshot cannot sit in this table indefinitely, and nothing
 *      is lost by removing something that could never fire.
 *
 * Deliberately not keyed on which people the purge touched. A cluster can drift
 * below the match threshold while still holding the deleted photo, and one
 * stored side can be represented by several current people — checking the whole
 * event sidesteps both, and it is a few hundred dot products on a path that
 * runs when a photo is destroyed.
 *
 * Best-effort: failing to tidy a dismissal row must not fail the delete.
 */
async function refreshSeparationSnapshots(eventId, conn = db) {
  if (!eventId) return;
  try {
    const rows = await conn('event_people_merge_dismissals')
      .where({ event_id: eventId })
      .select('id', 'centroid_a', 'centroid_b');
    if (!rows.length) return;

    const live = (await conn('event_people')
      .where({ event_id: eventId })
      .select('id', 'centroid'))
      .map((p) => ({ id: p.id, vec: unpackEmbedding(p.centroid) }))
      .filter((p) => p.vec);

    /** The live cluster this stored side still describes, if any. */
    const bestMatch = (vec) => {
      if (!vec) return null;
      let best = null;
      let bestScore = SEPARATION_MATCH_THRESHOLD;
      for (const person of live) {
        const score = dot(vec, person.vec);
        if (score >= bestScore) { bestScore = score; best = person; }
      }
      return best;
    };

    for (const row of rows) {
      const matchA = bestMatch(unpackEmbedding(row.centroid_a));
      const matchB = bestMatch(unpackEmbedding(row.centroid_b));

      // Both sides resolving to the SAME live cluster is the other way a row
      // stops describing anything: there are no longer two things here to keep
      // apart, so there is nothing left to enforce and no reason to keep the
      // vectors.
      if (!matchA || !matchB || matchA.id === matchB.id) {
        await conn('event_people_merge_dismissals').where({ id: row.id }).del();
        continue;
      }
      await conn('event_people_merge_dismissals').where({ id: row.id }).update({
        centroid_a: packEmbedding(matchA.vec),
        centroid_b: packEmbedding(matchB.vec),
      });
    }
  } catch (err) {
    if (isMissingTable(err)) return;
    logger.warn(`faceClustering: could not refresh separations for event ${eventId}`, {
      error: err.message,
    });
  }
}

/**
 * Remember that these two are NOT the same person, so the pair stops being
 * suggested. Normalized to (lower id, higher id) so the pair has one identity.
 */
async function dismissMergeSuggestion(eventId, personAId, personBId) {
  const lo = Math.min(personAId, personBId);
  const hi = Math.max(personAId, personBId);
  // Snapshot what the two clusters look like RIGHT NOW (#1132). The person ids
  // stop meaning anything the next time clustering is re-derived; these vectors
  // are what lets the decision outlive that.
  const snapshot = await separationSnapshot(eventId, lo, hi);
  try {
    await db('event_people_merge_dismissals').insert({
      event_id: eventId,
      person_a_id: lo,
      person_b_id: hi,
      ...snapshot,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // ONLY the UNIQUE constraint doing its job — dismissing twice is a
    // double-click, not an error. Anything else (missing table on a
    // pre-migration install, read-only database) must reach the caller:
    // reporting "kept separate" for a decision that was never stored is worse
    // than an error, because the pair silently comes back next scan.
    if (!isUniqueViolation(err)) throw err;
  }
  return { dismissed: true };
}

/**
 * Move every face from `sourceIds` onto `targetId` and delete the sources.
 * Recomputes the target centroid from its actual members rather than
 * averaging the two centroids — cheap at this scale, and exact.
 */
async function mergePeople(eventId, sourceIds, targetId) {
  const ids = sourceIds.filter((id) => id !== targetId);
  if (!ids.length) return { moved: 0 };

  return db.transaction(async (trx) => {
    // Carry metadata forward before the sources are deleted. Without this a
    // merge silently discards a photographer-entered name, or un-hides a
    // person they had suppressed — the target keeps its own values where it
    // has them, and inherits from a source only where it does not.
    const target = await trx('event_people').where({ id: targetId }).first();
    const sources = await trx('event_people').whereIn('id', ids)
      .select('centroid', 'label', 'is_hidden', 'is_ignored', 'cover_face_id');

    const inherited = {};
    if (target && !target.label) {
      const named = sources.find((p) => p.label);
      if (named) inherited.label = named.label;
    }
    // Suppression is one-way on merge: if ANY party was hidden or ignored,
    // the survivor stays that way. Re-exposing someone by merging is the
    // failure that matters; leaving them hidden is trivially reversible.
    // A chosen cover is human state like the label, and the merged face is
    // still in the cluster afterwards — so it survives the merge rather than
    // reverting to the automatic pick (#1096). The target's own choice wins.
    if (target && !target.cover_face_id) {
      const curated = sources.find((p) => p.cover_face_id);
      if (curated) inherited.cover_face_id = curated.cover_face_id;
    }
    if (sources.some((p) => p.is_hidden) || target?.is_hidden) inherited.is_hidden = true;
    if (sources.some((p) => p.is_ignored) || target?.is_ignored) inherited.is_ignored = true;

    const moved = await trx('photo_faces')
      .where({ event_id: eventId })
      .whereIn('person_id', ids)
      .update({ person_id: targetId });

    await trx('event_people').where({ event_id: eventId }).whereIn('id', ids).del();

    // A separation between people who are now being merged is a decision the
    // photographer has just reversed, and the newer decision wins. Leaving the
    // row would be worse than untidy since #1132: it is keyed on the centroids
    // too, so it outlives the ids it names and the next recluster would
    // recognise those sides and pull the merge apart again — silently undoing
    // an explicit human action.
    //
    // Matched the same way the constraint is enforced, not by id. A row that
    // has already survived a recluster names people who are gone, and an
    // id-only delete walks straight past precisely those rows — the ones with
    // a live vector-keyed constraint still in them. hasTable rather than a
    // catch, because a failed statement aborts the transaction on Postgres.
    const mergedIds = [targetId, ...ids];
    if (await trx.schema.hasTable('event_people_merge_dismissals')) {
      await trx('event_people_merge_dismissals')
        .where({ event_id: eventId })
        .whereIn('person_a_id', mergedIds)
        .whereIn('person_b_id', mergedIds)
        .del();

      const mergedVecs = [target, ...sources]
        .map((p) => unpackEmbedding(p?.centroid)).filter(Boolean);
      if (mergedVecs.length > 1) {
        const rows = await trx('event_people_merge_dismissals')
          .where({ event_id: eventId })
          .select('id', 'centroid_a', 'centroid_b');
        for (const row of rows) {
          const sep = [{
            a: unpackEmbedding(row.centroid_a),
            b: unpackEmbedding(row.centroid_b),
          }];
          if (!sep[0].a || !sep[0].b) continue;
          // Would this row have forbidden the merge that was just performed?
          // Then it is the decision being reversed.
          const forbids = mergedVecs.some((x, i) => mergedVecs.slice(i + 1)
            .some((y) => separationForbids(x, y, sep)));
          if (forbids) {
            await trx('event_people_merge_dismissals').where({ id: row.id }).del();
          }
        }
      }
    }

    if (Object.keys(inherited).length) {
      await trx('event_people').where({ id: targetId })
        .update({ ...inherited, updated_at: new Date().toISOString() });
    }

    await recomputeCentroid(targetId, trx);
    return { moved };
  });
}

/**
 * Pull `faceIds` out of their cluster into a brand-new person.
 */
async function splitPerson(eventId, personId, faceIds) {
  if (!faceIds?.length) return null;

  return db.transaction(async (trx) => {
    const faces = await trx('photo_faces')
      .where({ event_id: eventId, person_id: personId })
      .whereIn('id', faceIds)
      .select('id', 'embedding', 'model_version');

    if (!faces.length) return null;

    const [inserted] = await trx('event_people').insert({
      event_id: eventId,
      face_count_total: 0,
      model_version: faces[0].model_version,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    const newPersonId = typeof inserted === 'object' ? inserted.id : inserted;

    await trx('photo_faces')
      .whereIn('id', faces.map((f) => f.id))
      .update({ person_id: newPersonId });

    // Centroids FIRST, then the separation. The order is load-bearing (#1132):
    // at this point the new person has no centroid at all (it was inserted with
    // none) and the original still carries the faces being split out, so a
    // snapshot taken here would record one empty vector and one stale one —
    // and the separation would bind the wrong pair, or nothing at all.
    await recomputeCentroid(newPersonId, trx);
    await recomputeCentroid(personId, trx);

    // A split IS a "these are not the same person" decision, and it has to be
    // recorded as one (#1107). Consolidation runs automatically after every
    // scan, and two clusters a photographer pulled apart are look-alikes by
    // construction — their centroids usually sit above the merge threshold, so
    // the very next scan would put them straight back together and the manual
    // correction would look like it never happened.
    //
    // Keyed on the post-split centroids as well as the ids, so it also survives
    // the re-derivation that kills both person and face ids (#1132).
    const lo = Math.min(personId, newPersonId);
    const hi = Math.max(personId, newPersonId);
    const snapshot = await separationSnapshot(eventId, lo, hi, trx);
    await trx('event_people_merge_dismissals').insert({
      event_id: eventId,
      person_a_id: lo,
      person_b_id: hi,
      ...snapshot,
      created_at: new Date().toISOString(),
    }).catch((err) => {
      // Pre-migration install, or the pair was already separated once before.
      if (!isMissingTable(err) && !isUniqueViolation(err)) throw err;
    });

    return newPersonId;
  });
}

/**
 * Recompute one person's centroid and count from its member faces.
 * Deletes the person if it has no members left.
 */
async function recomputeCentroid(personId, trx = db) {
  const faces = await trx('photo_faces')
    .where({ person_id: personId })
    .select('id', 'embedding', 'det_score');

  if (!faces.length) {
    await trx('event_people').where({ id: personId }).del();
    return;
  }

  const vectors = faces.map((f) => unpackEmbedding(f.embedding)).filter(Boolean);
  if (!vectors.length) return;

  const mean = new Float32Array(vectors[0].length);
  for (const vec of vectors) {
    for (let i = 0; i < mean.length; i++) mean[i] += vec[i];
  }
  for (let i = 0; i < mean.length; i++) mean[i] /= vectors.length;

  // cover_face_id is left alone (#1096): it holds the photographer's pick and
  // nothing else, so a rescan or a merge must not touch it. If the chosen face
  // is gone the id simply dangles, and listPeople falls back to the derived
  // cover on the next read — self-healing, no reassociation needed.
  await trx('event_people').where({ id: personId }).update({
    centroid: packEmbedding(normalize(mean)),
    face_count_total: faces.length,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Re-derive every cluster in an event from stored embeddings, without
 * touching the sidecar. Needed after threshold tuning — the expensive part
 * (inference) is already done and cached in the rows.
 *
 * Preserves labels by re-attaching them to whichever new cluster inherited
 * the most faces from the old one. Without this, re-clustering a gallery
 * would silently discard every name the photographer typed.
 */
async function recluster(eventId) {
  const thresholds = await getThresholds();

  // Remember every person carrying HUMAN state — a name, or a hidden/ignored
  // decision. Keying this on `label` alone silently dropped the privacy flags
  // of unnamed people: a bystander the photographer had suppressed came back
  // guest-visible after one "Re-group people".
  const previousLabels = await db('event_people')
    .where({ event_id: eventId })
    .where(function () {
      this.whereNotNull('label')
        .orWhere('is_hidden', true)
        .orWhere('is_ignored', true)
        // A chosen cover is human state too, and re-grouping used to drop it
        // (#1096). Faces keep their ids across a recluster, so the choice can
        // follow its FACE into whichever new cluster ends up holding it.
        .orWhereNotNull('cover_face_id');
    })
    .select('id', 'label', 'is_hidden', 'is_ignored', 'cover_face_id');

  const priorMembership = new Map();
  if (previousLabels.length) {
    const rows = await db('photo_faces')
      .where({ event_id: eventId })
      .whereIn('person_id', previousLabels.map((p) => p.id))
      .select('id', 'person_id');
    for (const row of rows) priorMembership.set(row.id, row.person_id);
  }

  await db.transaction(async (trx) => {
    await trx('photo_faces').where({ event_id: eventId }).update({ person_id: null });
    await trx('event_people').where({ event_id: eventId }).del();
  });

  const faces = await db('photo_faces')
    .where({ event_id: eventId })
    .orderBy('id', 'asc')
    .select('id', 'embedding', 'model_version', 'det_score', 'bbox_w', 'bbox_h');

  const assignments = await assignFaces(eventId, faces, { thresholds });

  // Re-attach labels by majority inheritance.
  if (previousLabels.length) {
    const tally = new Map(); // newPersonId -> Map<oldPersonId, count>
    for (const { faceId, personId } of assignments) {
      if (personId == null) continue;
      const oldId = priorMembership.get(faceId);
      if (oldId == null) continue;
      if (!tally.has(personId)) tally.set(personId, new Map());
      const inner = tally.get(personId);
      inner.set(oldId, (inner.get(oldId) || 0) + 1);
    }

    // Suppression is OR-ed across EVERY ancestor that contributed faces to a
    // new cluster — not copied from the majority one. Reclustering can merge a
    // visible named person with a hidden one; taking the majority ancestor's
    // flags would then publish the hidden person's photos. Erring toward
    // staying hidden is trivially reversible; erring toward visible is not.
    const suppression = new Map(); // newId -> { is_hidden, is_ignored }
    for (const [newId, inner] of tally) {
      let hidden = false;
      let ignored = false;
      for (const oldId of inner.keys()) {
        const old = previousLabels.find((p) => p.id === oldId);
        if (!old) continue;
        if (old.is_hidden) hidden = true;
        if (old.is_ignored) ignored = true;
      }
      suppression.set(newId, { is_hidden: hidden, is_ignored: ignored });
    }

    // The NAME goes to exactly one cluster: the descendant that inherited the
    // MOST of that old person's faces, chosen globally. Iterating `tally` and
    // taking the first match gave the name to whichever cluster happened to
    // come first — an early outlier could take it while the real majority
    // cluster ended up unnamed.
    const bestDescendant = new Map(); // oldId -> { newId, count }
    for (const [newId, inner] of tally) {
      for (const [oldId, count] of inner) {
        const current = bestDescendant.get(oldId);
        if (!current || count > current.count) bestDescendant.set(oldId, { newId, count });
      }
    }

    const labelFor = new Map(); // newId -> label
    for (const [oldId, { newId }] of bestDescendant) {
      const old = previousLabels.find((p) => p.id === oldId);
      if (old?.label && !labelFor.has(newId)) labelFor.set(newId, old.label);
    }

    // The chosen COVER follows its face, not the majority: the point of the
    // choice is that specific photo, so it belongs to whichever cluster now
    // holds it — which is not always the one that inherited the most faces.
    const coverFor = new Map(); // newId -> faceId
    const newPersonOfFace = new Map(assignments.map((a) => [a.faceId, a.personId]));
    for (const old of previousLabels) {
      if (!old.cover_face_id) continue;
      const newId = newPersonOfFace.get(old.cover_face_id);
      if (newId != null && !coverFor.has(newId)) coverFor.set(newId, old.cover_face_id);
    }

    for (const newId of new Set([...suppression.keys(), ...coverFor.keys()])) {
      const flags = suppression.get(newId) || {};
      const update = { ...flags, updated_at: new Date().toISOString() };
      if (coverFor.has(newId)) update.cover_face_id = coverFor.get(newId);
      if (labelFor.has(newId)) update.label = labelFor.get(newId);
      await db('event_people').where({ id: newId }).update(update);
    }
  }

  for (const personId of new Set(assignments.map((a) => a.personId).filter(Boolean))) {
    await recomputeCentroid(personId);
  }
  await consolidate(eventId, { thresholds });

  const count = await db('event_people').where({ event_id: eventId }).count({ c: '*' }).first();
  logger.info(`faceClustering: reclustered event ${eventId} → ${count?.c ?? 0} people`);
  return Number(count?.c ?? 0);
}

module.exports = {
  packEmbedding,
  unpackEmbedding,
  dot,
  normalize,
  meetsQualityFloor,
  assignFaces,
  consolidate,
  suggestMerges,
  dismissMergeSuggestion,
  // Exported for the tests that pin which failures may be swallowed and which
  // must stop the pass.
  isUniqueViolation,
  isMissingTable,
  // Separation constraints (#1132) — exported so the tests can drive the
  // matching directly rather than only through a full clustering pass.
  loadSeparations,
  separationForbids,
  separationForbidsProjected,
  projectOnSeparations,
  refreshSeparationSnapshots,
  SEPARATION_MATCH_THRESHOLD,
  mergePeople,
  splitPerson,
  recomputeCentroid,
  recluster,
};
