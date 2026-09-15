'use strict';

/**
 * Migration 219: signatures v2 (#1446).
 *
 * - contract_signers: who signs a contract, in order — any number of
 *   customer signers and the issuer, each with its own signature slot.
 *   Name, email, IP address, user agent and a decline reason are stored
 *   encrypted with the evidence key (utils/fieldEncryption), not hashed,
 *   so a signer can be identified in a dispute; the email also has a hash
 *   for lookups.
 * - contract_signer_invitations: a signer's link; only the token's
 *   sha256 is stored.
 * - contract_signing_otps: the codes sent to a signer's email (bcrypt),
 *   with an expiry and an attempt count.
 * - contract_signing_sessions: what a verified signer (code or portal
 *   login) uses to open and sign; only the sha256 is stored.
 * - contract_signing_events: the append-only event log. Each event's hash
 *   covers the previous one's, and `occurred_at` holds the timestamp
 *   exactly as it was hashed.
 * - contracts: signing_version (NULL = the signing flow from before this
 *   migration, 2 = signers), signing_order, sealed_at, audit_chain_head,
 *   declined_at.
 *
 * Contracts sent before this migration keep their action tokens and sign
 * as before. Guarded, with a down().
 */

const CONTRACT_COLUMNS = [
  ['signing_version', (t) => t.integer('signing_version')],
  ['signing_order', (t) => t.string('signing_order', 16).notNullable().defaultTo('parallel')],
  ['sealed_at', (t) => t.timestamp('sealed_at')],
  ['audit_chain_head', (t) => t.string('audit_chain_head', 64)],
  ['declined_at', (t) => t.timestamp('declined_at')],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('contract_signers'))) {
    await knex.schema.createTable('contract_signers', (t) => {
      t.increments('id').primary();
      t.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
      t.integer('position').notNullable();
      t.string('role', 16).notNullable(); // customer | issuer
      t.string('slot_key', 32).notNullable();
      t.text('name_enc');
      t.text('email_enc');
      t.string('email_hash', 64);
      t.string('locale', 8);
      t.string('status', 16).notNullable().defaultTo('pending'); // pending | invited | signed | declined
      t.timestamp('invited_at');
      t.timestamp('verified_at');
      t.string('verified_via', 16); // otp | portal | admin
      t.timestamp('signed_at');
      t.timestamp('declined_at');
      t.text('decline_reason_enc');
      t.string('signature_mode', 16); // drawn | typed
      t.string('signature_path', 512);
      t.string('signature_sha256', 64);
      t.string('consent_version', 32);
      t.string('content_sha256', 64);
      t.string('document_sha256', 64);
      t.text('ip_enc');
      t.text('user_agent_enc');
      t.string('idempotency_key', 64);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.unique(['contract_id', 'slot_key']);
      t.index(['contract_id', 'position']);
      t.index(['email_hash']);
    });
  }

  if (!(await knex.schema.hasTable('contract_signer_invitations'))) {
    await knex.schema.createTable('contract_signer_invitations', (t) => {
      t.increments('id').primary();
      t.integer('signer_id').unsigned().notNullable().references('id').inTable('contract_signers').onDelete('CASCADE');
      t.string('token_hash', 64).notNullable().unique();
      t.timestamp('expires_at');
      t.timestamp('revoked_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['signer_id']);
    });
  }

  if (!(await knex.schema.hasTable('contract_signing_otps'))) {
    await knex.schema.createTable('contract_signing_otps', (t) => {
      t.increments('id').primary();
      t.integer('signer_id').unsigned().notNullable().references('id').inTable('contract_signers').onDelete('CASCADE');
      t.string('code_hash', 100).notNullable();
      t.timestamp('expires_at').notNullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.timestamp('consumed_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['signer_id', 'created_at']);
    });
  }

  if (!(await knex.schema.hasTable('contract_signing_sessions'))) {
    await knex.schema.createTable('contract_signing_sessions', (t) => {
      t.increments('id').primary();
      t.integer('signer_id').unsigned().notNullable().references('id').inTable('contract_signers').onDelete('CASCADE');
      t.string('session_hash', 64).notNullable().unique();
      t.string('verified_via', 16).notNullable(); // otp | portal
      t.timestamp('expires_at').notNullable();
      t.timestamp('revoked_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['signer_id']);
    });
  }

  if (!(await knex.schema.hasTable('contract_signing_events'))) {
    await knex.schema.createTable('contract_signing_events', (t) => {
      t.increments('id').primary();
      t.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
      t.integer('seq').notNullable();
      t.string('event_type', 40).notNullable();
      t.string('actor_type', 16).notNullable(); // system | admin | signer
      t.string('actor_label', 255);
      // No FK: the log is evidence and must not change when a row it names does.
      t.integer('signer_id');
      t.text('payload'); // canonical JSON
      t.string('artifact_sha256', 64);
      t.string('prev_hash', 64).notNullable();
      t.string('event_hash', 64).notNullable();
      t.string('occurred_at', 32).notNullable(); // ISO timestamp, exactly as hashed
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['contract_id', 'seq']);
    });
  }

  if (await knex.schema.hasTable('contracts')) {
    for (const [column, add] of CONTRACT_COLUMNS) {
      if (!(await knex.schema.hasColumn('contracts', column))) {
        await knex.schema.alterTable('contracts', (t) => add(t));
      }
    }
  }
};

async function dropContractColumns(knex) {
  if (!(await knex.schema.hasTable('contracts'))) return;
  for (const [column] of CONTRACT_COLUMNS) {
    if (await knex.schema.hasColumn('contracts', column)) {
      await knex.schema.alterTable('contracts', (t) => t.dropColumn(column));
    }
  }
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('contract_signing_events');
  await knex.schema.dropTableIfExists('contract_signing_sessions');
  await knex.schema.dropTableIfExists('contract_signing_otps');
  await knex.schema.dropTableIfExists('contract_signer_invitations');
  await knex.schema.dropTableIfExists('contract_signers');
  await dropContractColumns(knex);
};
