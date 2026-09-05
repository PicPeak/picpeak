// Existing participants retain their v1 consent and v1 allowlist. New fields
// require a separate explicit, signed upgrade; migrations never opt anyone in.
exports.up = async function (knex) {
  if (
    (await knex.schema.hasTable('product_usage_state')) &&
    !(await knex.schema.hasColumn('product_usage_state', 'consent_version'))
  ) {
    await knex.schema.alterTable('product_usage_state', (t) => {
      t.string('consent_version', 40).notNullable().defaultTo('usage-consent.v1');
    });
  }
};
exports.down = async function (knex) {
  if (
    (await knex.schema.hasTable('product_usage_state')) &&
    (await knex.schema.hasColumn('product_usage_state', 'consent_version'))
  ) {
    await knex.schema.alterTable('product_usage_state', (t) => t.dropColumn('consent_version'));
  }
};
