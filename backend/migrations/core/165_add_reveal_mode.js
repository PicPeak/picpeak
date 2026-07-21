/**
 * Reveal mode (#838): hide the gallery from guests until a manual or
 * scheduled reveal — guests can still upload, the host/admin/slideshow see
 * everything.
 *
 * - events.reveal_mode: the per-event toggle (only meaningful together with
 *   allow_user_uploads; off by default so nothing changes for existing events)
 * - events.reveal_at: optional scheduled reveal time. Effective visibility is
 *   computed at REQUEST time (reveal_at <= now opens the gate even before the
 *   scheduler runs), the minutely scheduler only stamps revealed_at durably.
 * - events.revealed_at: set by "Reveal now" or the scheduler; NULL while
 *   hidden. Re-enabling reveal_mode clears it (re-hide).
 */

// Each column guarded independently: a partially applied prior run (or a
// fork that added one of them) must not leave the others missing — the
// routes select all three.
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('events', 'reveal_mode'))) {
    await knex.schema.alterTable('events', (table) => {
      table.boolean('reveal_mode').defaultTo(false);
    });
  }
  if (!(await knex.schema.hasColumn('events', 'reveal_at'))) {
    await knex.schema.alterTable('events', (table) => {
      table.timestamp('reveal_at').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('events', 'revealed_at'))) {
    await knex.schema.alterTable('events', (table) => {
      table.timestamp('revealed_at').nullable();
    });
  }
};

exports.down = async function (knex) {
  for (const column of ['revealed_at', 'reveal_at', 'reveal_mode']) {
    if (await knex.schema.hasColumn('events', column)) {
      await knex.schema.alterTable('events', (table) => {
        table.dropColumn(column);
      });
    }
  }
};
