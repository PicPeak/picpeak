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

  const assignments = [];

  for (const face of faceRows) {
    const embedding = unpackEmbedding(face.embedding);
    if (!embedding) continue;

    if (!meetsQualityFloor(face, thresholds)) {
      assignments.push({ faceId: face.id, personId: null });
      continue;
    }

    let best = null;
    let bestScore = -Infinity;
    for (const person of state) {
      // Never compare across embedding spaces — a model change makes old
      // centroids meaningless rather than merely stale.
      if (person.modelVersion && face.model_version && person.modelVersion !== face.model_version) {
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
      assignments.push({ faceId: face.id, personId: best.id });
    } else {
      const [inserted] = await trx('event_people').insert({
        event_id: eventId,
        centroid: packEmbedding(embedding),
        face_count_total: 1,
        model_version: face.model_version,
        cover_face_id: face.id,
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
    .select('id', 'centroid', 'face_count_total', 'model_version', 'label');

  const state = people
    .map((p) => ({ ...p, vec: unpackEmbedding(p.centroid) }))
    .filter((p) => p.vec);

  const merged = [];
  const absorbed = new Set();

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

      if (dot(a.vec, b.vec) >= mergeThreshold) {
        await mergePeople(eventId, [b.id], a.id);
        absorbed.add(b.id);
        merged.push({ from: b.id, into: a.id });
      }
    }
  }

  if (merged.length) {
    logger.info(`faceClustering: consolidated ${merged.length} person pair(s) in event ${eventId}`);
  }
  return merged;
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
    const sources = await trx('event_people').whereIn('id', ids).select('label', 'is_hidden', 'is_ignored');

    const inherited = {};
    if (target && !target.label) {
      const named = sources.find((p) => p.label);
      if (named) inherited.label = named.label;
    }
    // Suppression is one-way on merge: if ANY party was hidden or ignored,
    // the survivor stays that way. Re-exposing someone by merging is the
    // failure that matters; leaving them hidden is trivially reversible.
    if (sources.some((p) => p.is_hidden) || target?.is_hidden) inherited.is_hidden = true;
    if (sources.some((p) => p.is_ignored) || target?.is_ignored) inherited.is_ignored = true;

    const moved = await trx('photo_faces')
      .where({ event_id: eventId })
      .whereIn('person_id', ids)
      .update({ person_id: targetId });

    await trx('event_people').where({ event_id: eventId }).whereIn('id', ids).del();

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

    await recomputeCentroid(newPersonId, trx);
    await recomputeCentroid(personId, trx);
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

  // Cover face: the highest-scoring detection in the cluster, so the avatar
  // is the sharpest available crop of that person rather than whichever face
  // happened to arrive first.
  const cover = faces.reduce((a, b) => ((b.det_score ?? 0) > (a.det_score ?? 0) ? b : a));

  await trx('event_people').where({ id: personId }).update({
    centroid: packEmbedding(normalize(mean)),
    face_count_total: faces.length,
    cover_face_id: cover.id,
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
      this.whereNotNull('label').orWhere('is_hidden', true).orWhere('is_ignored', true);
    })
    .select('id', 'label', 'is_hidden', 'is_ignored');

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

    for (const [newId, flags] of suppression) {
      const update = { ...flags, updated_at: new Date().toISOString() };
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
  mergePeople,
  splitPerson,
  recomputeCentroid,
  recluster,
};
