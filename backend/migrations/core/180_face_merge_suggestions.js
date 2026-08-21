/**
 * Automatic consolidation after a scan, and the suggestion band below it
 * (#1107).
 *
 * `faceClustering.consolidate()` has existed since #1074 but only ever ran from
 * `recluster()`, i.e. when an admin pressed "Re-group people". After a normal
 * background scan nobody looked, so a gallery settled with "Anna in daylight"
 * and "Anna at the party" as separate people even though their centroids had
 * long since converged.
 *
 * Two things get stored here.
 *
 * 1. `events.faces_last_consolidated_*` — merging biometric clusters silently
 *    is the wrong default even at high confidence, so a pass that merged
 *    anything has to be able to say so afterwards. The count is per-scan: the
 *    next consolidation overwrites it, which is the intended lifetime.
 *
 * 2. `event_people_merge_dismissals` — the band BELOW the auto-merge threshold
 *    is surfaced as a suggestion rather than merged, and a suggestion the
 *    photographer has rejected must stay rejected. Without this the same "are
 *    these the same person?" pair returns after every scan.
 *
 * The dismissal rows reference people that merge, split and recluster all
 * delete. That is deliberately NOT enforced with a foreign key: a dangling
 * dismissal simply stops matching anything, which is the correct outcome, and
 * an FK would either block those operations or need cascade rules on a table
 * whose whole purpose is to be advisory. `pruneDismissals` is not needed for
 * correctness — the rows are tiny and harmless.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events')) {
    const hasCount = await knex.schema.hasColumn('events', 'faces_last_consolidated_count');
    const hasAt = await knex.schema.hasColumn('events', 'faces_last_consolidated_at');
    if (!hasCount || !hasAt) {
      await knex.schema.alterTable('events', (table) => {
        if (!hasCount) table.integer('faces_last_consolidated_count').defaultTo(0);
        if (!hasAt) table.timestamp('faces_last_consolidated_at').nullable();
      });
    }
  }

  if (!(await knex.schema.hasTable('event_people_merge_dismissals'))) {
    await knex.schema.createTable('event_people_merge_dismissals', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable();
      // Stored with person_a_id < person_b_id so a pair has exactly one row
      // regardless of which order the comparison produced it in.
      table.integer('person_a_id').notNullable();
      table.integer('person_b_id').notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.unique(['event_id', 'person_a_id', 'person_b_id']);
      table.index(['event_id']);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('event_people_merge_dismissals')) {
    await knex.schema.dropTable('event_people_merge_dismissals');
  }
  if (await knex.schema.hasTable('events')) {
    const hasCount = await knex.schema.hasColumn('events', 'faces_last_consolidated_count');
    const hasAt = await knex.schema.hasColumn('events', 'faces_last_consolidated_at');
    if (hasCount || hasAt) {
      await knex.schema.alterTable('events', (table) => {
        if (hasCount) table.dropColumn('faces_last_consolidated_count');
        if (hasAt) table.dropColumn('faces_last_consolidated_at');
      });
    }
  }
};
