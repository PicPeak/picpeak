/**
 * One row per external file per event (#1162).
 *
 * The migration has two halves and they fail differently: the cleanup can take
 * out the wrong row of a pair (losing a thumbnail, orphaning an event's hero),
 * and the index can fail to be created at all — leaving an install that looks
 * migrated and is still racing. Both are pinned here.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const migration = require('../../migrations/core/186_external_relpath_unique');

describe('migration 186 — unique (event_id, external_relpath) (#1162)', () => {
  let knex; let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig186-'));
    knex = require('knex')({
      client: 'sqlite3',
      connection: { filename: path.join(tmpDir, 'db.sqlite') },
      useNullAsDefault: true,
    });
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    for (const table of [
      'photos', 'events', 'photo_categories', 'photo_feedback',
      'photo_admin_marks', 'photo_faces', 'image_access_logs', 'transfer_files',
      'event_people', 'event_people_merge_dismissals',
    ]) {
      await knex.schema.dropTableIfExists(table);
    }
    await knex.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.integer('hero_photo_id');
      t.string('download_zip_path');
      t.string('download_zip_generated_at');
    });
    await knex.schema.createTable('photo_categories', (t) => {
      t.increments('id').primary();
      t.integer('hero_photo_id');
    });
    await knex.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('external_relpath');
      t.string('thumbnail_path');
      t.string('source_origin').defaultTo('managed');
      t.integer('feedback_count').defaultTo(0);
      t.integer('like_count').defaultTo(0);
      t.decimal('average_rating', 3, 2).defaultTo(0);
      t.integer('favorite_count').defaultTo(0);
      t.integer('reaction_count').defaultTo(0);
      t.integer('color_label_count').defaultTo(0);
      t.string('face_status');
      t.integer('view_count').defaultTo(0);
      t.integer('download_count').defaultTo(0);
      t.integer('face_count');
      t.string('face_started_at');
      t.text('face_error');
    });
    // Declared exactly as the real schema declares them — CASCADE and all.
    // The point of these tables here is that SQLite does NOT enforce any of
    // it (PicPeak never sets `PRAGMA foreign_keys = ON`), so a bare delete of
    // the photo row leaves every one of them dangling.
    await knex.schema.createTable('photo_feedback', (t) => {
      t.increments('id').primary();
      t.integer('photo_id').references('id').inTable('photos').onDelete('CASCADE');
      t.integer('event_id');
      t.string('feedback_type');
      t.text('comment_text');
      t.string('guest_identifier');
      // Per-person guest identity (migration 078). Nullable: galleries without
      // guest identity leave it NULL and fall back to guest_identifier.
      t.integer('guest_id');
      t.integer('rating');
      t.boolean('is_hidden').defaultTo(false);
      t.boolean('is_approved').defaultTo(true);
    });
    await knex.schema.createTable('photo_admin_marks', (t) => {
      t.increments('id').primary();
      t.integer('photo_id').notNullable().references('id').inTable('photos').onDelete('CASCADE');
      t.integer('event_id');
      t.integer('admin_id');
      t.integer('rating');
      // Independently writable alongside rating, per photoAdminMarksService.
      t.string('color_label', 16);
      t.unique(['photo_id', 'admin_id'], 'photo_admin_marks_photo_admin_uniq');
    });
    await knex.schema.createTable('photo_faces', (t) => {
      t.increments('id').primary();
      t.integer('photo_id').references('id').inTable('photos').onDelete('CASCADE');
      t.integer('event_id');
      // purgePhotoFaces rebuilds the people that lose members, so the cluster
      // link and the vectors recomputeCentroid reads have to be here for this
      // to exercise the real path rather than a stub.
      t.integer('person_id');
      t.binary('embedding');
      t.float('det_score');
    });
    await knex.schema.createTable('event_people', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.binary('centroid');
      t.integer('face_count').defaultTo(0);
    });
    await knex.schema.createTable('event_people_merge_dismissals', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.binary('centroid_a');
      t.binary('centroid_b');
    });
    await knex.schema.createTable('image_access_logs', (t) => {
      t.increments('id').primary();
      t.integer('photo_id');
    });
    await knex.schema.createTable('transfer_files', (t) => {
      t.increments('id').primary();
      t.integer('transfer_id');
      t.integer('photo_id');
      t.unique(['transfer_id', 'photo_id'], 'transfer_files_unique');
    });
  });

  /** Two duplicate rows for the same file: id 1 survives, id 2 is doomed. */
  const seedPair = async () => {
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
    ]);
  };

  const rows = () => knex('photos').orderBy('id', 'asc').select('*');

  it('collapses a duplicated pair to one row and leaves distinct paths alone', async () => {
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't1', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't2', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/y.jpg', thumbnail_path: 't3', source_origin: 'external' },
    ]);

    await migration.up(knex);

    const after = await rows();
    expect(after.map((r) => r.external_relpath)).toEqual(['a/x.jpg', 'a/y.jpg']);
    // Lowest id survives when both sides are equally complete.
    expect(after[0].id).toBe(1);
  });

  it('does not collapse the same path across different events', async () => {
    // The constraint is per event. Two events referencing the same NAS folder
    // is a supported setup, and treating those as duplicates would delete one
    // event's entire library.
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
      { event_id: 2, external_relpath: 'a/x.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    expect(await knex('photos').count('* as c').first()).toEqual({ c: 2 });
  });

  it('never touches managed rows, however many carry NULL', async () => {
    // Every managed photo has external_relpath NULL. Grouping on it without
    // the NOT NULL filter would make them all one enormous "duplicate" group
    // and delete the entire library bar one row.
    await knex('photos').insert([
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
    ]);

    await migration.up(knex);

    expect(await knex('photos').count('* as c').first()).toEqual({ c: 3 });
  });

  it('keeps the row that has a thumbnail, not merely the lowest id', async () => {
    // An import killed mid-flight leaves rows without a thumbnail. Dropping
    // the completed one would blank a tile in the grid for no reason.
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: null, source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 'thumb.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);

    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0].thumbnail_path).toBe('thumb.jpg');
  });

  it('repoints a hero that pointed at the row being removed', async () => {
    // events.hero_photo_id is ON DELETE SET NULL, so without this the cleanup
    // silently strips the event's hero image — a visible regression caused
    // entirely by the fix.
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
    ]);
    await knex('events').insert({ id: 1, hero_photo_id: 2 });
    await knex('photo_categories').insert({ id: 1, hero_photo_id: 2 });

    await migration.up(knex);

    expect((await knex('events').where({ id: 1 }).first()).hero_photo_id).toBe(1);
    expect((await knex('photo_categories').where({ id: 1 }).first()).hero_photo_id).toBe(1);
  });

  it('leaves a hero that pointed at the survivor untouched', async () => {
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', thumbnail_path: 't', source_origin: 'external' },
    ]);
    await knex('events').insert({ id: 1, hero_photo_id: 1 });

    await migration.up(knex);

    expect((await knex('events').where({ id: 1 }).first()).hero_photo_id).toBe(1);
  });

  it('makes a second insert of the same path impossible afterwards', async () => {
    // The whole point. Without this the route is still racing, and the
    // migration is recorded as applied.
    await knex('photos').insert({ event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' });

    await migration.up(knex);

    await expect(
      knex('photos').insert({ event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' })
    ).rejects.toThrow(/unique/i);
  });

  it('still admits managed rows once the index exists', async () => {
    await migration.up(knex);

    await knex('photos').insert([
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
      { event_id: 1, external_relpath: null, source_origin: 'managed' },
    ]);

    expect(await knex('photos').count('* as c').first()).toEqual({ c: 2 });
  });

  it('leaves nothing dangling behind the deleted row', async () => {
    // SQLite never enforces the ON DELETE CASCADE these tables declare, so a
    // bare delete strands biometric embeddings, feedback and marks pointing at
    // a photo id that no longer exists — on every SQLite install.
    await seedPair();
    await knex('photo_faces').insert({ photo_id: 2, event_id: 1 });
    await knex('image_access_logs').insert({ photo_id: 2 });

    await migration.up(knex);

    expect(await knex('photo_faces').where('photo_id', 2).first()).toBeUndefined();
    expect(await knex('image_access_logs').where('photo_id', 2).first()).toBeUndefined();
  });

  it('does not carry the duplicate\'s faces over to the survivor', async () => {
    // Both rows were scanned independently, so the survivor already holds its
    // own embeddings. Moving these would fabricate a second copy of every face
    // and split the person clusters built from them.
    await seedPair();
    await knex('photo_faces').insert([{ photo_id: 1, event_id: 1 }, { photo_id: 2, event_id: 1 }]);

    await migration.up(knex);

    expect(await knex('photo_faces').count('* as c').first()).toEqual({ c: 1 });
  });

  it('moves a guest comment to the survivor rather than deleting it', async () => {
    // The duplicates were separate tiles in the grid, so a guest could have
    // commented on either. Silently dropping that inside a fix for silent data
    // loss would be its own bug.
    await seedPair();
    await knex('photo_feedback').insert({
      photo_id: 2, event_id: 1, feedback_type: 'comment',
      comment_text: 'lovely shot', guest_identifier: 'guest-a',
    });

    await migration.up(knex);

    const rows = await knex('photo_feedback');
    expect(rows).toHaveLength(1);
    expect(rows[0].photo_id).toBe(1);
    expect(rows[0].comment_text).toBe('lovely shot');
  });

  it('keeps both comments when the same guest commented on both tiles', async () => {
    await seedPair();
    await knex('photo_feedback').insert([
      { photo_id: 1, event_id: 1, feedback_type: 'comment', comment_text: 'one', guest_identifier: 'g' },
      { photo_id: 2, event_id: 1, feedback_type: 'comment', comment_text: 'two', guest_identifier: 'g' },
    ]);

    await migration.up(knex);

    const rows = await knex('photo_feedback').orderBy('id');
    expect(rows.map((r) => r.comment_text)).toEqual(['one', 'two']);
    expect(rows.every((r) => r.photo_id === 1)).toBe(true);
  });

  it('does not double-count a like the same guest left on both tiles', async () => {
    // Unlike comments, a like is a per-guest toggle: moving it would show two
    // likes from one person.
    await seedPair();
    await knex('photo_feedback').insert([
      { photo_id: 1, event_id: 1, feedback_type: 'like', guest_identifier: 'g' },
      { photo_id: 2, event_id: 1, feedback_type: 'like', guest_identifier: 'g' },
    ]);

    await migration.up(knex);

    expect(await knex('photo_feedback').count('* as c').first()).toEqual({ c: 1 });
  });

  it('moves a like from a guest the survivor has never seen', async () => {
    await seedPair();
    await knex('photo_feedback').insert({
      photo_id: 2, event_id: 1, feedback_type: 'like', guest_identifier: 'other',
    });

    await migration.up(knex);

    const rows = await knex('photo_feedback');
    expect(rows).toHaveLength(1);
    expect(rows[0].photo_id).toBe(1);
  });

  it('moves an admin mark, and drops it when that admin already marked the survivor', async () => {
    // photo_admin_marks is UNIQUE(photo_id, admin_id), so a blind move would
    // throw and abort the migration.
    await seedPair();
    await knex('photo_admin_marks').insert([
      { photo_id: 1, event_id: 1, admin_id: 7, rating: 5 },
      { photo_id: 2, event_id: 1, admin_id: 7, rating: 2 },
      { photo_id: 2, event_id: 1, admin_id: 9, rating: 4 },
    ]);

    await migration.up(knex);

    const rows = await knex('photo_admin_marks').orderBy('admin_id');
    expect(rows.map((r) => [r.admin_id, r.rating])).toEqual([[7, 5], [9, 4]]);
    expect(rows.every((r) => r.photo_id === 1)).toBe(true);
  });

  it('respects the transfer_files uniqueness when moving membership', async () => {
    await seedPair();
    await knex('transfer_files').insert([
      { transfer_id: 3, photo_id: 1 },
      { transfer_id: 3, photo_id: 2 },
      { transfer_id: 4, photo_id: 2 },
    ]);

    await migration.up(knex);

    const rows = await knex('transfer_files').orderBy('transfer_id');
    expect(rows.map((r) => r.transfer_id)).toEqual([3, 4]);
    expect(rows.every((r) => r.photo_id === 1)).toBe(true);
  });

  it('recomputes the survivor\'s feedback totals after reparenting rows', async () => {
    // photos carries denormalized counters (migration 033). A survivor that
    // now OWNS the feedback but still renders zero is the visible half of
    // getting this wrong.
    await seedPair();
    await knex('photo_feedback').insert([
      { photo_id: 2, event_id: 1, feedback_type: 'like', guest_identifier: 'g1' },
      { photo_id: 2, event_id: 1, feedback_type: 'rating', rating: 4, guest_identifier: 'g1' },
    ]);

    await migration.up(knex);

    const survivor = await knex('photos').where('id', 1).first();
    expect(survivor.like_count).toBe(1);
    expect(Number(survivor.average_rating)).toBe(4);
    expect(survivor.feedback_count).toBe(1);
  });

  it('keeps two people who share a device apart', async () => {
    // guest_identifier is per-device; guest_id is per-person (migration 078),
    // and feedbackService scopes by guest_id when it is present. Keying on the
    // identifier alone would read these as one person and delete a rating.
    await seedPair();
    await knex('photo_feedback').insert([
      { photo_id: 1, event_id: 1, feedback_type: 'rating', rating: 5, guest_identifier: 'shared', guest_id: 10 },
      { photo_id: 2, event_id: 1, feedback_type: 'rating', rating: 2, guest_identifier: 'shared', guest_id: 11 },
    ]);

    await migration.up(knex);

    const rows = await knex('photo_feedback').orderBy('guest_id');
    expect(rows.map((r) => [r.guest_id, r.rating])).toEqual([[10, 5], [11, 2]]);
  });

  it('still dedupes one person voting on both tiles', async () => {
    await seedPair();
    await knex('photo_feedback').insert([
      { photo_id: 1, event_id: 1, feedback_type: 'like', guest_identifier: 'shared', guest_id: 10 },
      { photo_id: 2, event_id: 1, feedback_type: 'like', guest_identifier: 'shared', guest_id: 10 },
    ]);

    await migration.up(knex);

    expect(await knex('photo_feedback').count('* as c').first()).toEqual({ c: 1 });
  });

  it('rebuilds the people that lose members, rather than deleting faces raw', async () => {
    // purgePhotoFaces is "called from every photo-deletion path" precisely
    // because event_people counts and centroids are derived from the rows
    // being removed. A bare delete leaves a ghost person behind.
    await seedPair();
    await knex('event_people').insert({ id: 5, event_id: 1, face_count: 1 });
    await knex('photo_faces').insert({ photo_id: 2, event_id: 1, person_id: 5 });

    await migration.up(knex);

    expect(await knex('photo_faces').count('* as c').first()).toEqual({ c: 0 });
    // The person had exactly one member and loses it, so it goes with it.
    expect(await knex('event_people').where('id', 5).first()).toBeUndefined();
  });

  it('keeps a hidden moderation record from swallowing the visible replacement', async () => {
    // feedbackService lets both coexist and counts only the visible one.
    await seedPair();
    await knex('photo_feedback').insert([
      { photo_id: 1, event_id: 1, feedback_type: 'like', guest_identifier: 'g', is_hidden: true },
      { photo_id: 2, event_id: 1, feedback_type: 'like', guest_identifier: 'g', is_hidden: false },
    ]);

    await migration.up(knex);

    expect(await knex('photo_feedback').count('* as c').first()).toEqual({ c: 2 });
  });

  it('merges the independent halves of one admin\'s mark', async () => {
    // rating and color_label are written independently, so the same admin can
    // have rated one tile and coloured the other.
    await seedPair();
    await knex('photo_admin_marks').insert([
      { photo_id: 1, event_id: 1, admin_id: 7, rating: 5, color_label: null },
      { photo_id: 2, event_id: 1, admin_id: 7, rating: null, color_label: 'red' },
    ]);

    await migration.up(knex);

    const rows = await knex('photo_admin_marks');
    expect(rows).toHaveLength(1);
    expect([rows[0].rating, rows[0].color_label]).toEqual([5, 'red']);
  });

  it('requeues the survivor when the duplicate held the only scan', async () => {
    // Otherwise the sole embeddings go with the purge and nothing re-queues:
    // the photo just silently stops having a face.
    await seedPair();
    await knex('photo_faces').insert({ photo_id: 2, event_id: 1 });

    await migration.up(knex);

    expect((await knex('photos').where('id', 1).first()).face_status).toBe('pending');
  });

  it('carries the duplicate\'s views and downloads over', async () => {
    await seedPair();
    await knex('photos').where('id', 1).update({ view_count: 2, download_count: 1 });
    await knex('photos').where('id', 2).update({ view_count: 5, download_count: 3 });

    await migration.up(knex);

    const survivor = await knex('photos').where('id', 1).first();
    expect([survivor.view_count, survivor.download_count]).toEqual([7, 4]);
  });

  it('fails loudly rather than recording itself applied without the index', async () => {
    // Swallowing a failed CREATE INDEX would leave the install permanently
    // racy — the in-flight guard only covers one process — with nothing to
    // trigger a retry. Driven through the helper the migration calls, against
    // a table that still holds duplicates — i.e. what it would face if the
    // dedupe above had not achieved uniqueness.
    await seedPair();
    const { createExternalRelpathIndex } = require('../../src/services/externalPhotoDedupe');

    await expect(createExternalRelpathIndex(knex)).rejects.toThrow(/unique/i);
  });

  it('invalidates the pre-built download zip for the affected event', async () => {
    // The cached archive still contains the rows just removed, and every
    // ordinary photo-deletion path invalidates it for exactly that reason.
    // getZipInfo treats a cleared record as a miss and rebuilds on request.
    await seedPair();
    await knex('events').insert({
      id: 1, download_zip_path: 'events/active/x/.download-cache/all.zip',
      download_zip_generated_at: '2026-01-01',
    });

    await migration.up(knex);

    const ev = await knex('events').where('id', 1).first();
    expect(ev.download_zip_path).toBeNull();
    expect(ev.download_zip_generated_at).toBeNull();
  });

  it('leaves an untouched event\'s zip alone', async () => {
    await seedPair();
    await knex('events').insert([
      { id: 1, download_zip_path: 'a.zip', download_zip_generated_at: '2026-01-01' },
      { id: 2, download_zip_path: 'b.zip', download_zip_generated_at: '2026-01-01' },
    ]);

    await migration.up(knex);

    expect((await knex('events').where('id', 2).first()).download_zip_path).toBe('b.zip');
  });

  it('is idempotent', async () => {
    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
    ]);

    await migration.up(knex);
    const once = await rows();
    await migration.up(knex);

    expect(await rows()).toEqual(once);
  });

  it('rolls back to an unconstrained table', async () => {
    await migration.up(knex);
    await migration.down(knex);

    await knex('photos').insert([
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
      { event_id: 1, external_relpath: 'a/x.jpg', source_origin: 'external' },
    ]);
    expect(await knex('photos').count('* as c').first()).toEqual({ c: 2 });
  });

  it('no-ops before 041 has added the column', async () => {
    await knex.schema.dropTableIfExists('photos');
    await knex.schema.createTable('photos', (t) => { t.increments('id').primary(); });

    await expect(migration.up(knex)).resolves.toBeUndefined();
  });
});
