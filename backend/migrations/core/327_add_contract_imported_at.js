/**
 * Historical contract import: POST /api/admin/contracts/import attaches an
 * original PDF from the tool a studio is moving off (Pixieset, HoneyBook,
 * paper, ...) as an already-signed or cancelled contract, without sending
 * anything. `imported_at` marks those rows. The uploaded PDF is the record,
 * so the services refuse to re-render, re-stamp, counter-sign or replace it,
 * the same way an invoice's `imported_pdf_path` short-circuits its renderer.
 *
 * NULL for every existing contract.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('contracts', 'imported_at');
  if (!has) {
    await knex.schema.alterTable('contracts', (t) => {
      t.timestamp('imported_at').nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('contracts', 'imported_at');
  if (has) {
    await knex.schema.alterTable('contracts', (t) => {
      t.dropColumn('imported_at');
    });
  }
};
