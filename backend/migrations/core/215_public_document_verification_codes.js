/**
 * Migration 215: one-time codes for the public contract and quote pages.
 *
 * The link in a contract or quote email used to be the only secret: whoever
 * held it saw the customer's name, email address and the full document, and
 * could sign or respond. The public page now asks for a 6-digit code emailed
 * to the customer on file first. This table stores those codes, bcrypt-hashed,
 * one row per send, keyed to the action token they unlock; the send throttle
 * is derived from `created_at`, so no extra table is needed.
 *
 * Additive and idempotent: creates the table only when missing, and `down`
 * drops it only when present.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('public_document_verification_codes')) return;
  await knex.schema.createTable('public_document_verification_codes', (t) => {
    t.increments('id').primary();
    // 'contract' | 'quote' — which *_action_tokens table action_token_id points at.
    t.string('document_kind', 16).notNullable();
    t.integer('action_token_id').notNullable();
    t.string('code_hash', 128).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('expires_at').notNullable();
    t.timestamp('consumed_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['document_kind', 'action_token_id'], 'public_doc_verification_codes_token_idx');
  });
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('public_document_verification_codes')) {
    await knex.schema.dropTable('public_document_verification_codes');
  }
};
