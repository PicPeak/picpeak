// Supersedes the boolean added in 202. A boolean cannot distinguish "a
// withdrawal arrived while this activation was starting" from "a withdrawal
// from an earlier participation was never cleared": clearing it needed its
// own write, and a /disable landing between the lease and that write was
// erased. A monotonic counter needs no clearing — enable() records the value
// it started with and claims only if it is unchanged, so any intervening
// withdrawal is visible whatever the previous state was.
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('product_usage_state'))) return;
  if (!(await knex.schema.hasColumn('product_usage_state', 'cancel_seq')))
    await knex.schema.alterTable('product_usage_state', (t) => {
      t.bigInteger('cancel_seq').notNullable().defaultTo(0);
    });
  if (await knex.schema.hasColumn('product_usage_state', 'cancel_requested'))
    await knex.schema.alterTable('product_usage_state', (t) => {
      t.dropColumn('cancel_requested');
    });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('product_usage_state'))) return;
  if (await knex.schema.hasColumn('product_usage_state', 'cancel_seq'))
    await knex.schema.alterTable('product_usage_state', (t) => {
      t.dropColumn('cancel_seq');
    });
};
