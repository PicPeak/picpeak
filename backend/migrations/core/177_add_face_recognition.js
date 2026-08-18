/**
 * Migration 177: Face recognition — "People in this gallery" (#1074).
 *
 * Adds two tables and four columns for per-gallery face detection and
 * clustering. People are clustered INSIDE one event; there is deliberately no
 * cross-event person identity, so `event_people` hangs off `events` and every
 * query is naturally scoped to one gallery.
 *
 * Three decisions worth knowing before reading the schema:
 *
 *   1. Embeddings are a plain binary column, not a vector type. 512 float32 =
 *      2KB per face, and a 2,000-photo wedding at ~3 faces/photo is ~12MB —
 *      small enough that no pgvector extension is needed and the SQLite path
 *      behaves identically. Clustering runs in JS over hundreds to low
 *      thousands of rows per event.
 *
 *   2. `photos.face_status` is NULLABLE with no default, and this migration
 *      enqueues NOTHING. A default of 'pending' would silently queue every
 *      photo on every install the moment this ran — including installs with
 *      no sidecar and no intention of using the feature. Rows are enqueued
 *      only by an explicit per-event opt-in.
 *
 *   3. `event_people.face_count_total` is named for what it is: a count over
 *      ALL faces, including photos a guest cannot see. Guests are restricted
 *      to `photos.visibility = 'visible'` (gallery.js), so a guest-facing
 *      count and cover face MUST be computed per request against that same
 *      predicate. The name is a deterrent: anything reading
 *      `face_count_total` in a guest path is a bug.
 *
 * Face embeddings are biometric data — GDPR Art. 9 special category. Both
 * tables are excluded from backups and from .picpeak exports (see
 * picpeakExportService and databaseBackup): the data is derived, so a restore
 * re-scans rather than carrying biometrics between deployments.
 */

const GLOBAL_DEFAULTS = [
  // Cosine similarity above which a face joins an existing person.
  //
  // 0.60, measured twice — and the second measurement overruled the first,
  // which is the whole reason this comment is long.
  //
  // LFW's standard 1000-pair protocol through this exact pipeline gives
  // same-person cosine 0.696 +/- 0.142, different-person 0.085 +/- 0.167,
  // peak accuracy 96.6% at 0.405. Reading that as a clustering threshold
  // suggests ~0.50 (1.0% false merge, 8.2% false split pairwise).
  //
  // Running it on an actual gallery says otherwise. At 0.50, three of six
  // visible clusters were contaminated — two different people merged into
  // one strip entry. PAIRWISE ERROR RATES DO NOT PREDICT CLUSTER PURITY:
  // greedy assignment compounds, because one wrong face drags the centroid
  // toward the midpoint between two identities, which makes the next wrong
  // face likelier. A 1% pairwise false-merge rate is not a 1% chance of a
  // clean gallery.
  //
  // Sweep on a 61-photo / 5-identity gallery (ml/tools/benchmark_threshold.py
  // covers the pairwise half; the cluster half is the `recluster` endpoint):
  //     0.50 -> 6 clusters, 3 contaminated
  //     0.56 -> 6 clusters, 0 contaminated
  //     0.60 -> 5 clusters, 0 contaminated   <- ground truth is 5
  //     0.64 -> 5 clusters, 0 contaminated, fewer faces assigned
  //
  // 0.60 recovers the exact right number of people with no contamination.
  // Higher only drops coverage. A false merge puts a stranger into someone's
  // "download my photos" and cannot be undone until the Phase 2 merge/split
  // UI ships, so contamination is the constraint being optimised against,
  // not accuracy.
  ['face_match_threshold', 0.60],
  // Faces a cluster needs before it appears in the guest-facing strip. Keeps
  // one-off bystanders out of "People in this gallery".
  ['face_min_cluster_size', 3],
  // Quality floor. Faces below any of these are still stored (so "this photo
  // contains" stays accurate) but are left unassigned, so they cannot spawn
  // junk people.
  ['face_quality_min_score', 0.7],
  ['face_quality_min_px', 40],
  // Phase 3 rule engine. Present here so the settings block has one home.
  ['face_auto_categorize_enabled', false],
];

exports.up = async function (knex) {
  // --- event_people -------------------------------------------------------
  // Created before photo_faces: photo_faces.person_id references it. The
  // reverse direction (event_people.cover_face_id → photo_faces.id) is a
  // forward reference and is deliberately left WITHOUT a foreign key —
  // Postgres rejects an FK to a table that doesn't exist yet, and adding it
  // afterwards buys nothing here because the column is nullable and the
  // clustering code always writes an id it just inserted. Migration 001 hit
  // exactly this with events.hero_photo_id (#484).
  if (!(await knex.schema.hasTable('event_people'))) {
    await knex.schema.createTable('event_people', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      // NULL until a photographer names them. The UI shows a photo count
      // instead — a number is honest, an invented "Person 7" is not.
      table.string('label', 255);
      table.integer('cover_face_id');
      // Running-mean centroid of the cluster's embeddings, 512 float32.
      table.binary('centroid');
      // Count over ALL faces — see note 3 in the header. NEVER guest-facing.
      table.integer('face_count_total').notNullable().defaultTo(0);
      table.string('model_version', 64);
      // Photographer-only: hidden people never reach a guest response.
      table.boolean('is_hidden').notNullable().defaultTo(false);
      // Bystanders and false positives — excluded from the strip entirely.
      table.boolean('is_ignored').notNullable().defaultTo(false);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['event_id'], 'event_people_event_idx');
    });
  }

  // --- photo_faces --------------------------------------------------------
  if (!(await knex.schema.hasTable('photo_faces'))) {
    await knex.schema.createTable('photo_faces', (table) => {
      table.increments('id').primary();
      table.integer('photo_id').unsigned().notNullable()
        .references('id').inTable('photos').onDelete('CASCADE');
      // Denormalized from photos.event_id. Every clustering and people query
      // is per-event; without this they would all join through photos.
      table.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');

      // Bounding box in ORIGINAL image pixels (the sidecar reports original
      // coordinates even though it detects on a downscaled copy), so cover
      // avatars can be cropped from any rendition by ratio.
      table.float('bbox_x').notNullable();
      table.float('bbox_y').notNullable();
      table.float('bbox_w').notNullable();
      table.float('bbox_h').notNullable();

      table.float('det_score');
      table.float('yaw');
      table.float('pitch');
      table.float('blur');

      // 512 × float32, L2-normalized. See note 1.
      table.binary('embedding');
      // Which detector+embedder+alignment produced this. Embeddings from two
      // pipelines are not comparable, so a model change re-derives rather
      // than silently mixing two spaces.
      table.string('model_version', 64);

      // SET NULL rather than CASCADE: deleting a person must un-assign its
      // faces, never delete the detections themselves.
      table.integer('person_id').unsigned()
        .references('id').inTable('event_people').onDelete('SET NULL');

      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['photo_id'], 'photo_faces_photo_idx');
      table.index(['event_id', 'person_id'], 'photo_faces_event_person_idx');
    });
  }

  // --- photos -------------------------------------------------------------
  //
  // Every column added in ONE alterTable, not one call each. This migration
  // replays in ~90 test suites that boot a database from scratch, and each
  // ALTER is its own statement and its own fsync — the per-column version of
  // this was measurably slower on CI's shared disk than the whole rest of the
  // chain. Same reason the settings seed below is one round trip.
  if (await knex.schema.hasTable('photos')) {
    const wanted = {
      // NULL = never queued. See note 2 — this migration enqueues nothing.
      // pending | processing | done | failed | skipped
      face_status: (t) => t.string('face_status', 16),
      face_count: (t) => t.integer('face_count'),
      // Set when a row is claimed, so the janitor can recover it after a
      // worker dies mid-photo. Mirrors photos.processing_started_at.
      face_started_at: (t) => t.timestamp('face_started_at'),
      face_error: (t) => t.text('face_error'),
    };
    const missing = [];
    for (const name of Object.keys(wanted)) {
      if (!(await knex.schema.hasColumn('photos', name))) missing.push(name);
    }
    if (missing.length) {
      await knex.schema.alterTable('photos', (table) => {
        for (const name of missing) wanted[name](table);
        // Index for the queue claim, added in the same statement. The worker
        // polls face_status='pending' constantly; without it that is a full
        // scan of `photos` on every tick.
        if (missing.includes('face_status')) {
          table.index(['face_status'], 'photos_face_status_idx');
        }
      });
    }
  }

  // --- events -------------------------------------------------------------
  if (await knex.schema.hasTable('events')) {
    const wanted = {
      // Per-event opt-in. NULL and false both mean off; the column is
      // nullable only so an existing row doesn't need backfilling.
      face_recognition_enabled: (t) => t.boolean('face_recognition_enabled'),
      // When detection is on, does the GUEST see the people strip? Off means
      // the photographer gets the tool and guests see an unchanged gallery.
      // Defaults to on, but only matters once the above is enabled.
      faces_visible_to_guests: (t) => t.boolean('faces_visible_to_guests'),
      faces_last_scan_at: (t) => t.timestamp('faces_last_scan_at'),
    };
    const missing = [];
    for (const name of Object.keys(wanted)) {
      if (!(await knex.schema.hasColumn('events', name))) missing.push(name);
    }
    if (missing.length) {
      await knex.schema.alterTable('events', (table) => {
        for (const name of missing) wanted[name](table);
      });
    }
  }

  // --- app_settings -------------------------------------------------------
  if (!(await knex.schema.hasTable('app_settings'))) return;

  // One SELECT and at most one INSERT, rather than a SELECT+INSERT per key.
  const keys = GLOBAL_DEFAULTS.map(([k]) => k);
  const present = new Set(
    (await knex('app_settings').whereIn('setting_key', keys).select('setting_key'))
      .map((r) => r.setting_key)
  );
  const rows = GLOBAL_DEFAULTS
    .filter(([key]) => !present.has(key))
    .map(([key, value]) => ({
      setting_key: key,
      // JSON-stringified so SQLite (TEXT) and Postgres (JSONB) round-trip
      // the same shape — matches migrations 104 and 173.
      setting_value: JSON.stringify(value),
      setting_type: 'faces',
      // ISO string, not a Date: under Jest, Date objects handed to the
      // sqlite3 binding store as the literal "[object Object]".
      updated_at: new Date().toISOString(),
    }));
  if (rows.length) await knex('app_settings').insert(rows);
};

exports.down = async function (knex) {
  // photo_faces first — it holds the FK into event_people.
  await knex.schema.dropTableIfExists('photo_faces');
  await knex.schema.dropTableIfExists('event_people');

  if (await knex.schema.hasTable('photos')) {
    for (const name of ['face_status', 'face_count', 'face_started_at', 'face_error']) {
      if (await knex.schema.hasColumn('photos', name)) {
        await knex.schema.alterTable('photos', (table) => table.dropColumn(name));
      }
    }
  }

  if (await knex.schema.hasTable('events')) {
    for (const name of [
      'face_recognition_enabled',
      'faces_visible_to_guests',
      'faces_last_scan_at',
    ]) {
      if (await knex.schema.hasColumn('events', name)) {
        await knex.schema.alterTable('events', (table) => table.dropColumn(name));
      }
    }
  }

  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings')
      .whereIn('setting_key', GLOBAL_DEFAULTS.map(([k]) => k))
      .del();
  }
};
