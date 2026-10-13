/**
 * Migration 297: automatic scene tags (issue 1733).
 *
 * `photo_tags` holds what the optional ML sidecar's /tags endpoint reported
 * for a photo: a key from the fixed vocabulary (ml/app/tag_vocabulary.json)
 * and its score. No image embedding is stored.
 *
 * The queue is four columns on `photos`, modelled on the face queue of
 * migration 177, and for the same reason `tag_status` is nullable with no
 * default: this migration queues nothing. A photo is queued only once the
 * `autoTagging` feature flag and the gallery's own switch are both on.
 * `tag_attempt_id` names one claim, as `web_attempt_id` does for the
 * rendition queue (migration 279): a result is written only while the row
 * still carries the id of the claim that produced it.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('photo_tags'))) {
    await knex.schema.createTable('photo_tags', (table) => {
      table.increments('id').primary();
      table.integer('photo_id').unsigned().notNullable()
        .references('id').inTable('photos').onDelete('CASCADE');
      // Denormalized from photos.event_id, like photo_faces: the tag counts
      // of a gallery are per event.
      table.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      table.string('tag', 64).notNullable();
      table.float('score').notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.unique(['photo_id', 'tag'], { indexName: 'photo_tags_photo_tag_unique' });
      table.index(['event_id', 'tag'], 'photo_tags_event_tag_idx');
    });
  }

  if (await knex.schema.hasTable('photos')) {
    const wanted = {
      // NULL = never queued. pending | processing | done | failed | skipped
      tag_status: (t) => t.string('tag_status', 16),
      // Set when a row is claimed, so the janitor can return it after a
      // worker died mid-photo.
      tag_started_at: (t) => t.timestamp('tag_started_at'),
      // The claim a result must belong to. NULL whenever the row is not
      // 'processing'.
      tag_attempt_id: (t) => t.string('tag_attempt_id', 36),
      tag_error: (t) => t.text('tag_error'),
    };
    const missing = [];
    for (const name of Object.keys(wanted)) {
      if (!(await knex.schema.hasColumn('photos', name))) missing.push(name);
    }
    if (missing.length) {
      await knex.schema.alterTable('photos', (table) => {
        for (const name of missing) wanted[name](table);
        // The worker polls tag_status = 'pending' on every tick.
        if (missing.includes('tag_status')) {
          table.index(['tag_status'], 'photos_tag_status_idx');
        }
      });
    }
  }

  // Per-gallery switch. NULL and false both mean off.
  if (await knex.schema.hasTable('events')
    && !(await knex.schema.hasColumn('events', 'auto_tagging_enabled'))) {
    await knex.schema.alterTable('events', (table) => {
      table.boolean('auto_tagging_enabled');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('photo_tags');

  if (await knex.schema.hasTable('photos')) {
    if (await knex.schema.hasColumn('photos', 'tag_status')) {
      await knex.schema.alterTable('photos', (table) => {
        table.dropIndex(['tag_status'], 'photos_tag_status_idx');
      });
    }
    for (const name of ['tag_status', 'tag_started_at', 'tag_attempt_id', 'tag_error']) {
      if (await knex.schema.hasColumn('photos', name)) {
        await knex.schema.alterTable('photos', (table) => table.dropColumn(name));
      }
    }
  }

  if (await knex.schema.hasTable('events')
    && await knex.schema.hasColumn('events', 'auto_tagging_enabled')) {
    await knex.schema.alterTable('events', (table) => table.dropColumn('auto_tagging_enabled'));
  }
};
