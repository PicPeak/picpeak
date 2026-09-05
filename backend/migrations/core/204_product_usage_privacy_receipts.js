// Bounded, local-only audit receipts. Never retain an installation identity,
// signing key, report/feedback payload or collector credential after opt-out.
exports.up = async function (knex) {
  if (
    (await knex.schema.hasTable('product_usage_state')) &&
    !(await knex.schema.hasColumn('product_usage_state', 'privacy_receipts'))
  ) {
    await knex.schema.alterTable('product_usage_state', (t) =>
      t.text('privacy_receipts')
    );
  }
  if (await knex.schema.hasColumn('product_usage_state', 'last_receipt')) {
    const row = await knex('product_usage_state').where({ id: 1 }).first();
    if (row?.last_receipt) {
      const receipt = JSON.parse(row.last_receipt);
      if (receipt.session_token) {
        delete receipt.session_token;
        await knex('product_usage_state')
          .where({ id: 1 })
          .update({ last_receipt: JSON.stringify(receipt) });
      }
    }
  }
};
exports.down = async function (knex) {
  if (
    (await knex.schema.hasTable('product_usage_state')) &&
    (await knex.schema.hasColumn('product_usage_state', 'privacy_receipts'))
  ) {
    await knex.schema.alterTable('product_usage_state', (t) =>
      t.dropColumn('privacy_receipts')
    );
  }
};
