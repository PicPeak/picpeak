// Separate from 201 deliberately. 201 already shipped on this branch, and
// knex records it as applied — so folding the column into it would silently
// skip every database that had already run it, and the first /disable would
// fail on a missing column. Its own migration runs everywhere.
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('product_usage_state'))) return;
  if (await knex.schema.hasColumn('product_usage_state', 'cancel_requested')) return;
  await knex.schema.alterTable('product_usage_state', (t) => {
    // Set by /disable so an activation still generating its identity — during
    // which the row still reads `disabled` — cannot go on to complete after
    // the admin has asked to withdraw.
    t.boolean('cancel_requested').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('product_usage_state'))) return;
  if (!(await knex.schema.hasColumn('product_usage_state', 'cancel_requested'))) return;
  await knex.schema.alterTable('product_usage_state', (t) => {
    t.dropColumn('cancel_requested');
  });
};
