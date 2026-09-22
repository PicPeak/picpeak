'use strict';

/**
 * Migration 252: versioned, hashed consents for contract signatures (#1446).
 *
 * Until now the declaration a signer confirms ("I have read this contract
 * and agree to be bound by its terms") lived only in the frontend's
 * translations: it was neither stored nor hashed, and the certificate had
 * no row for it.
 *
 * - contract_template_versions.consents: the declarations a version asks
 *   for, as JSON `[{ key, required, version, text: { en, de } }]`. Frozen
 *   with the version when it is published, and copied into a contract's
 *   content snapshot at send, so the hash a signature is bound to covers the
 *   wording.
 * - contract_signer_consents: what each signer answered, per declaration —
 *   its key, version, the sha256 of its wording, accepted or not, and when.
 *
 * Backfill: every existing version gets exactly today's wording as its one
 * required declaration, so nothing a customer sees changes. One UPDATE of
 * the rows that have none yet — atomic, and a re-run finds nothing to do.
 * Published versions keep the content_sha256 they were published with: it
 * was computed before declarations existed, and rewriting it would rewrite
 * what that version recorded. `consents_backfilled_at` marks those rows, so
 * their hash is known not to cover the declarations; versions published
 * after this cover them.
 */

const DEFAULT_CONSENTS = [{
  key: 'acceptance',
  required: true,
  version: 1,
  text: {
    en: 'I have read this contract and agree to be bound by its terms.',
    de: 'Ich habe diesen Vertrag gelesen und erkläre mich mit seinen Bedingungen einverstanden.',
  },
}];


exports.up = async function up(knex) {
  if (await knex.schema.hasTable('contract_template_versions')) {
    if (!(await knex.schema.hasColumn('contract_template_versions', 'consents'))) {
      await knex.schema.alterTable('contract_template_versions', (t) => t.text('consents'));
    }
    if (!(await knex.schema.hasColumn('contract_template_versions', 'consents_backfilled_at'))) {
      await knex.schema.alterTable('contract_template_versions', (t) => t.timestamp('consents_backfilled_at'));
    }
    await knex('contract_template_versions')
      .whereNull('consents')
      .update({ consents: JSON.stringify(DEFAULT_CONSENTS), consents_backfilled_at: new Date().toISOString() });
  }

  if (await knex.schema.hasTable('contract_signers') && !(await knex.schema.hasTable('contract_signer_consents'))) {
    await knex.schema.createTable('contract_signer_consents', (t) => {
      t.increments('id').primary();
      t.integer('signer_id').unsigned().notNullable()
        .references('id').inTable('contract_signers').onDelete('CASCADE');
      t.string('consent_key', 40).notNullable();
      t.integer('version').notNullable();
      t.string('text_sha256', 64).notNullable();
      t.boolean('accepted').notNullable();
      t.timestamp('accepted_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['signer_id', 'consent_key']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('contract_signer_consents');
  for (const column of ['consents_backfilled_at', 'consents']) {
    if (await knex.schema.hasTable('contract_template_versions')
      && await knex.schema.hasColumn('contract_template_versions', column)) {
      await knex.schema.alterTable('contract_template_versions', (t) => t.dropColumn(column));
    }
  }
};
