/**
 * Migration 178: auto-categorised flag (#1074 phase 3).
 *
 * Marks photos whose category was assigned by the face-count rule engine
 * rather than by a person. That distinction is what makes "undo all automatic
 * categories" a single query instead of an archaeology exercise, and it is
 * why the engine can promise never to touch a photographer's own choices.
 *
 * Separate from 177 rather than folded into it: 177 has already run wherever
 * this branch has been deployed, so editing it would be a no-op there and a
 * silent schema divergence between installs.
 *
 * Nullable with no default. NULL and false both mean "a human chose this (or
 * nothing did)", which is the safe reading for every pre-existing row —
 * backfilling `false` would say the same thing at the cost of rewriting the
 * whole table.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (await knex.schema.hasColumn('photos', 'auto_categorized')) return;

  // Column and index in ONE statement — this replays in ~90 test suites that
  // build a database from scratch, and each separate ALTER costs a statement
  // and an fsync there. See the note in 177.
  await knex.schema.alterTable('photos', (table) => {
    table.boolean('auto_categorized');
    // The undo path filters on this alone across a whole event, so it is
    // worth an index on installs where most photos are NOT auto-categorised.
    table.index(['auto_categorized'], 'photos_auto_categorized_idx');
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'auto_categorized'))) return;

  await knex.schema.alterTable('photos', (table) => {
    table.dropColumn('auto_categorized');
  });
};
