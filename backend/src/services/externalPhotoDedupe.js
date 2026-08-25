/**
 * One row per external file per event (#1162).
 *
 * The import route used to check for an existing external_relpath and then
 * insert, with an fs.stat and a Sharp decode in between — wide enough that two
 * overlapping imports both walked through it. A reporter's event held 8004 rows
 * for 6012 distinct paths.
 *
 * This lives in a service rather than inside migration 186 because it has two
 * callers. The migration is one. The other is a .picpeak restore: the archive
 * carries the photos table verbatim, so a backup taken before this fix lands
 * duplicate rows into a schema that now has a unique index on them — and
 * neither Postgres' `session_replication_role = replica` nor SQLite's
 * `defer_foreign_keys` disables a UNIQUE index, so batchInsert would abort the
 * whole restore after every table had already been emptied.
 *
 * DELETING dependent rows explicitly, rather than trusting ON DELETE CASCADE,
 * is the load-bearing part. Every FK into photos declares CASCADE, but PicPeak
 * does not set `PRAGMA foreign_keys = ON` — the codebase says so in as many
 * words where it deletes an event (adminEvents/helpers.js:245-249) — so on
 * every SQLite install the cascade is inert and a bare delete would leave
 * dangling face embeddings, feedback and marks behind. The same reason
 * `hero_photo_id` is repointed by hand: its SET NULL is inert there too, so
 * without it a SQLite install keeps a hero pointing at a row that is gone.
 *
 * Guest and admin state is MOVED to the survivor where it can be, not
 * discarded. The duplicates were separate tiles in the grid, so a guest's
 * comment or an admin's rating could legitimately be attached to either, and
 * silently deleting it inside a fix for silent data loss would be its own bug.
 * Where the target already holds an equivalent row — the same guest's like on
 * the same photo, the same admin's mark, the same transfer's entry — the loser
 * is dropped instead, because those tables mean "one per (photo, actor)" and
 * moving would either violate a unique constraint or double-count.
 *
 * photo_faces is the deliberate exception: both rows were scanned
 * independently, so the survivor already has its own embeddings and moving the
 * duplicate's would fabricate a second copy of every face and split the
 * person clusters built from them.
 */

const { isUniqueViolation } = require('../utils/dbErrors');

const CHUNK = 400; // SQLite caps a statement at 999 bound parameters.
// Joins the parts of an equivalence key. Escaped, not a literal: a raw NUL in
// the source makes git classify this whole file as binary and hide its diffs.
const KEY_SEP = '\u0000';
const INDEX_NAME = 'photos_event_external_relpath_uniq';

const chunked = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
};

/** Pure log rows — nothing is lost by dropping them with the duplicate. */
const LOG_TABLES = [
  ['image_access_logs', 'photo_id'],
  ['transfer_downloads', 'photo_id'],
];

/**
 * Tables holding one row per (photo, actor). `keys` is what makes two rows
 * equivalent, so a move that would collide becomes a delete instead.
 */
const MOVE_TABLES = [
  {
    table: 'photo_feedback',
    // Guest identity, the way feedbackService defines it: guest_id when the
    // gallery uses per-person guests (migration 078), guest_identifier
    // otherwise — the same COALESCE its own duplicate-check and stats
    // aggregate use (feedbackService.js:208, :559). Keying on
    // guest_identifier alone would treat two DIFFERENT people sharing a
    // device as one and delete one of their ratings.
    identity: (row) => (row.guest_id != null ? `id:${row.guest_id}` : `anon:${row.guest_identifier}`),
    // is_hidden is part of the identity, not noise: feedbackService lets a
    // moderator-hidden row coexist with the guest's visible replacement and
    // excludes hidden rows from the counts. Without it the visible row is
    // dropped as redundant against the hidden one.
    keys: ['feedback_type', 'is_hidden'],
    // A comment is distinct content, never a per-guest toggle: two comments
    // from one guest are two comments, so they always move.
    alwaysMove: (row) => row.feedback_type === 'comment',
  },
  {
    table: 'photo_admin_marks',
    keys: ['admin_id'],
    // rating and color_label are independently writable, so the same admin can
    // have rated one tile and colour-labelled the other. Dropping the loser
    // outright would lose a half the survivor's row has no value for.
    mergeFields: ['rating', 'color_label'],
  },
  { table: 'transfer_files', keys: ['transfer_id'] },
];

const equivalenceKey = (spec, row) => [
  spec.identity ? spec.identity(row) : '',
  ...spec.keys.map((k) => row[k]),
].join(KEY_SEP);

async function repointColumn(knex, table, column, doomedToSurvivor) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, column))) return;
  for (const [doomed, survivor] of doomedToSurvivor) {
    await knex(table).where(column, doomed).update({ [column]: survivor });
  }
}

async function moveOrDrop(knex, spec, doomedToSurvivor, touched) {
  if (!(await knex.schema.hasTable(spec.table))) return;

  for (const [doomed, survivor] of doomedToSurvivor) {
    const rows = await knex(spec.table).where('photo_id', doomed);
    if (!rows.length) continue;
    if (touched) touched.add(survivor);

    const existing = await knex(spec.table).where('photo_id', survivor);
    const taken = new Set(existing.map((r) => equivalenceKey(spec, r)));

    for (const row of rows) {
      const key = equivalenceKey(spec, row);
      const move = (spec.alwaysMove && spec.alwaysMove(row)) || !taken.has(key);
      if (!move) {
        // Before dropping the loser, hand over any field the winner has no
        // value for — otherwise an independently-set half goes with it.
        if (spec.mergeFields) {
          const winner = existing.find((r) => equivalenceKey(spec, r) === key);
          const fill = {};
          for (const field of spec.mergeFields) {
            if (winner && winner[field] == null && row[field] != null) fill[field] = row[field];
          }
          if (winner && Object.keys(fill).length) {
            await knex(spec.table).where('id', winner.id).update(fill);
            Object.assign(winner, fill);
          }
        }
        await knex(spec.table).where('id', row.id).del();
        continue;
      }
      try {
        await knex(spec.table).where('id', row.id).update({ photo_id: survivor });
        taken.add(key);
      } catch (err) {
        // A unique constraint we did not model. The row is redundant with one
        // the survivor already has, so dropping it is correct — but anything
        // else must surface rather than leave a dangling photo_id behind.
        if (!isUniqueViolation(err)) throw err;
        await knex(spec.table).where('id', row.id).del();
      }
    }
  }
}

/**
 * Remove every photo row in `doomedToSurvivor`, moving or dropping the state
 * that hangs off it first. Safe on both engines and on schemas that predate
 * any of the dependent tables.
 */
async function deleteDuplicatePhotos(knex, doomedToSurvivor) {
  const doomed = [...doomedToSurvivor.keys()];
  if (!doomed.length) return 0;

  // SET NULL is as inert as CASCADE on SQLite, so an event whose hero happened
  // to be the duplicate would silently lose its hero image.
  await repointColumn(knex, 'events', 'hero_photo_id', doomedToSurvivor);
  await repointColumn(knex, 'photo_categories', 'hero_photo_id', doomedToSurvivor);

  const feedbackTouched = new Set();
  for (const spec of MOVE_TABLES) {
    await moveOrDrop(knex, spec, doomedToSurvivor, spec.table === 'photo_feedback' ? feedbackTouched : null);
  }

  // photos carries denormalized feedback totals (migration 033:
  // feedback_count, like_count, average_rating, favorite_count, and later
  // reaction/colour counts). Reparenting rows without recomputing leaves a
  // survivor that now OWNS feedback still rendering zero.
  if (feedbackTouched.size && await knex.schema.hasColumn('photos', 'feedback_count')) {
    const feedbackService = require('./feedbackService');
    for (const survivor of feedbackTouched) {
      await feedbackService.updatePhotoFeedbackStats(survivor, knex);
    }
  }

  for (const [table, column] of LOG_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const ids of chunked(doomed)) await knex(table).whereIn(column, ids).del();
  }

  // Both rows were scanned, so the survivor has its own faces; moving the
  // duplicate's would double every embedding and split the person clusters.
  //
  // Through purgePhotoFaces, not a raw delete: deleting the rows is only half
  // of it. event_people counts and centroids are derived from the faces being
  // removed, and #1132's separation snapshots hold a COPY of each side's
  // centroid — so a bare delete leaves ghost or inflated people and vectors
  // built from photos that no longer exist. faceProcessor says as much: it is
  // "called from every photo-deletion path".
  if (await knex.schema.hasTable('photo_faces')) {
    // If the ONLY completed scan of this file belonged to the duplicate, the
    // purge below takes the sole embeddings with it and nothing re-queues the
    // survivor — it just silently stops having a face. Mark those for a
    // rescan; the worker picks up 'pending' on its own.
    const needsRescan = [];
    for (const [doomedId, survivorId] of doomedToSurvivor) {
      if (!(await knex('photo_faces').where('photo_id', doomedId).first())) continue;
      if (!(await knex('photo_faces').where('photo_id', survivorId).first())) needsRescan.push(survivorId);
    }

    let purgePhotoFaces = null;
    try {
      ({ purgePhotoFaces } = require('./faceProcessor'));
    } catch (err) {
      // Face detection is optional; an install without it still needs the rows
      // gone so nothing dangles on SQLite.
      purgePhotoFaces = null;
    }
    if (purgePhotoFaces) {
      for (const id of doomed) await purgePhotoFaces(id, knex);
    } else {
      for (const ids of chunked(doomed)) await knex('photo_faces').whereIn('photo_id', ids).del();
    }

    if (needsRescan.length && await knex.schema.hasColumn('photos', 'face_status')) {
      for (const ids of chunked(needsRescan)) {
        await knex('photos').whereIn('id', ids).update({ face_status: 'pending' });
      }
    }
  }

  // Real interactions, recorded per row. Deleting the duplicate would quietly
  // lower the engagement the admin grid shows for a photo people did view and
  // download.
  if (await knex.schema.hasColumn('photos', 'view_count')) {
    for (const [doomedId, survivorId] of doomedToSurvivor) {
      const from = await knex('photos').where('id', doomedId)
        .select('view_count', 'download_count').first();
      if (!from) continue;
      const add = {};
      if (from.view_count) add.view_count = knex.raw('COALESCE(view_count, 0) + ?', [from.view_count]);
      if (from.download_count) add.download_count = knex.raw('COALESCE(download_count, 0) + ?', [from.download_count]);
      if (Object.keys(add).length) await knex('photos').where('id', survivorId).update(add);
    }
  }

  for (const ids of chunked(doomed)) await knex('photos').whereIn('id', ids).del();
  return doomed.length;
}

/**
 * Which rows are duplicates, and which one survives.
 *
 * Survivor: the lowest id that has a thumbnail_path, else the lowest id.
 * Thumbnails are generated per row during import, so on a duplicated pair both
 * usually have one and the tie-break never fires — but an import killed
 * mid-flight leaves rows without, and dropping the one that HAS the thumbnail
 * would blank a grid tile for no reason.
 */
async function planDedupe(knex) {
  const dupKeys = await knex('photos')
    .whereNotNull('external_relpath')
    .select('event_id')
    .count('* as c')
    .groupBy('event_id', 'external_relpath')
    .havingRaw('count(*) > 1');

  const doomedToSurvivor = new Map();

  for (const eventId of new Set(dupKeys.map((r) => r.event_id))) {
    const rows = await knex('photos')
      .where('event_id', eventId)
      .whereNotNull('external_relpath')
      .select('id', 'external_relpath', 'thumbnail_path')
      .orderBy('id', 'asc');

    const byPath = new Map();
    for (const row of rows) {
      const group = byPath.get(row.external_relpath);
      if (group) group.push(row);
      else byPath.set(row.external_relpath, [row]);
    }

    for (const group of byPath.values()) {
      if (group.length < 2) continue;
      const survivor = group.find((r) => r.thumbnail_path) || group[0];
      for (const row of group) {
        if (row.id !== survivor.id) doomedToSurvivor.set(row.id, survivor.id);
      }
    }
  }

  return doomedToSurvivor;
}

/** @returns {Promise<number>} how many duplicate rows were removed. */
async function dedupeExternalPhotos(knex) {
  if (!(await knex.schema.hasTable('photos'))) return 0;
  if (!(await knex.schema.hasColumn('photos', 'external_relpath'))) return 0;
  return deleteDuplicatePhotos(knex, await planDedupe(knex));
}

/** Is the index actually there? Asked of the catalog, not inferred. */
async function externalRelpathIndexExists(knex) {
  const isPg = knex.client && knex.client.config && knex.client.config.client === 'pg';
  const row = isPg
    ? await knex('pg_indexes').where('indexname', INDEX_NAME).first()
    : await knex('sqlite_master').where({ type: 'index', name: INDEX_NAME }).first();
  return !!row;
}

/**
 * The error a failed index MUST raise.
 *
 * Deliberately carries no `code`. run-migrations-safe.js treats 23505, 42P07,
 * 42701 and 42710 as "schema already exists" and marks the migration applied
 * (run-migrations-safe.js:138) — and a CREATE UNIQUE INDEX that finds
 * duplicate rows raises exactly 23505 on Postgres. Letting the driver's error
 * through would therefore record 186 as done on an install that never got the
 * index, with nothing to trigger a retry: the precise outcome the throw
 * exists to prevent.
 */
function indexFailure(detail) {
  return new Error(
    `Could not create ${INDEX_NAME}: ${detail}. The photos table still holds `
    + 'duplicate (event_id, external_relpath) rows — most likely inserted by a '
    + 'concurrent import while this migration ran. Stop other writers and re-run.'
  );
}

/**
 * Partial, so the managed rows — which all carry NULL — are not indexed at
 * all. Both engines treat NULLs as distinct in a unique index, so a plain one
 * would also be correct, but it would carry every managed photo for no query
 * that ever uses it.
 */
async function createExternalRelpathIndex(knex) {
  try {
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME} `
      + 'ON photos (event_id, external_relpath) WHERE external_relpath IS NOT NULL'
    );
  } catch (err) {
    throw indexFailure(err.message);
  }
  // IF NOT EXISTS makes the statement itself a poor witness, and a replica
  // inserting a duplicate between the dedupe and this lock is a real rolling-
  // deploy shape. Ask the catalog.
  if (!(await externalRelpathIndexExists(knex))) {
    throw indexFailure('the index is absent afterwards');
  }
}

async function dropExternalRelpathIndex(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
}

module.exports = {
  dedupeExternalPhotos,
  externalRelpathIndexExists,
  deleteDuplicatePhotos,
  planDedupe,
  createExternalRelpathIndex,
  dropExternalRelpathIndex,
  INDEX_NAME,
};
