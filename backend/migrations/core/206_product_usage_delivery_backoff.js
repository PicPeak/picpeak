// Retry pacing for the collector. Without it every failed packet was retried
// on the next admin request: /activity is open to any authenticated admin and
// the settings ticker fires it every five minutes per open tab, so an
// installation whose packet the collector rejects permanently hammered it
// once per admin action, forever, with a failing request sitting on the
// critical path of that action.
//
// `attempts` counts consecutive failures and `next_attempt_at` is the epoch-ms
// gate the automatic sender honours. Explicit operator actions — Retry and
// Disable — pass through regardless; the point is to pace the unattended loop,
// not to make the admin wait out a backoff they asked to skip.
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('product_usage_state'))) return;
  if (!(await knex.schema.hasColumn('product_usage_state', 'attempts')))
    await knex.schema.alterTable('product_usage_state', (t) => {
      t.integer('attempts').notNullable().defaultTo(0);
    });
  if (!(await knex.schema.hasColumn('product_usage_state', 'next_attempt_at')))
    await knex.schema.alterTable('product_usage_state', (t) => {
      t.bigInteger('next_attempt_at').notNullable().defaultTo(0);
    });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('product_usage_state'))) return;
  for (const column of ['attempts', 'next_attempt_at'])
    if (await knex.schema.hasColumn('product_usage_state', column))
      await knex.schema.alterTable('product_usage_state', (t) => {
        t.dropColumn(column);
      });
};
