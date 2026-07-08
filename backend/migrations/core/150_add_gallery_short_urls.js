/**
 * Migration 150: branded URL shortener for gallery share links (#699).
 *
 * Lets admins create custom-named short URLs that resolve to a gallery's
 * full link (e.g. `/s/sofia-graduation` → `/gallery/<slug>`). The short
 * URL itself answers bot-UA requests with server-rendered OG metadata,
 * so the SHORT URL is the one that shows the rich preview in iMessage /
 * Facebook / WhatsApp — not just the destination.
 *
 * Backward-compat invariant: this migration only ADDS a new table. No
 * existing route, table, or column is touched. Operators upgrading
 * through this migration can opt into creating short URLs per event,
 * but every existing `/gallery/...` link continues to resolve identically
 * — the new feature is additive.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('gallery_short_urls')) return;

  await knex.schema.createTable('gallery_short_urls', (t) => {
    t.increments('id').primary();
    // Public-facing slug — what appears in /s/<short_slug>. Case-folded
    // to lowercase at write time by the service; the UNIQUE index here
    // is the last line of defence against collisions.
    t.string('short_slug', 64).notNullable().unique();
    // Hard FK to events — when an admin deletes an event, its short
    // URLs go with it. ON DELETE CASCADE is the natural model: a short
    // URL that points at a vanished gallery has no useful behaviour.
    t.integer('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    // Where the short URL resolves to — usually `/gallery/<slug>` or
    // `/gallery/<share_token>` depending on the operator's #525
    // "Use short gallery URLs" setting at create time. Stored at create
    // time so a later flip of the global toggle doesn't silently change
    // what existing short URLs redirect to.
    t.text('target_path').notNullable();
    // For the audit trail + admin UI ("created by Alex two days ago").
    t.integer('created_by').references('id').inTable('admin_users');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // Tiny analytics — admins want to know "is this branded link
    // actually being clicked?" without a separate analytics service.
    t.integer('hit_count').notNullable().defaultTo(0);
    t.timestamp('last_hit_at');
    // Soft-delete semantics: a deleted short URL returns 410 Gone (not
    // 404) so the admin sees their delete was intentional, and so a
    // re-create with the same slug is an explicit "yes, replace" rather
    // than accidentally taking over a stale link. The UNIQUE constraint
    // on short_slug means re-create after delete requires either NULLing
    // the deleted row's slug or hard-deleting it; service layer handles
    // that explicitly.
    t.timestamp('deleted_at');
    t.integer('deleted_by').references('id').inTable('admin_users');
  });

  // Read patterns:
  //  - /s/:slug hot path — UNIQUE constraint on short_slug already
  //    provides the index. No additional index needed.
  //  - Admin UI "list short URLs for this event" — index event_id.
  await knex.schema.alterTable('gallery_short_urls', (t) => {
    t.index(['event_id'], 'gallery_short_urls_event_id_idx');
  });
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('gallery_short_urls')) {
    await knex.schema.dropTable('gallery_short_urls');
  }
};
