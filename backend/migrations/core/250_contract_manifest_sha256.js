'use strict';

/**
 * Migration 250: the attachment manifest bound into a signature (#1446).
 *
 * The content snapshot's sha256 covers the contract's words and, since
 * snapshot format 2, its price. The attachment manifest — every attachment
 * that goes with the contract, merged or delivered separately, with its own
 * sha256, delivery and page count — was stored next to the unsigned PDF but
 * hashed into nothing, so a separately delivered attachment was bound to no
 * signature at all.
 *
 * - contracts.attachment_manifest_sha256: the manifest's canonical sha256,
 *   frozen at send.
 * - contract_signers.manifest_sha256: the value each signer signed against.
 *
 * NULL on contracts sent before this: they sign as before, unchecked.
 */

const COLUMNS = [
  ['contracts', 'attachment_manifest_sha256'],
  ['contract_signers', 'manifest_sha256'],
];

exports.up = async function up(knex) {
  for (const [table, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, column))) {
      await knex.schema.alterTable(table, (t) => t.string(column, 64));
    }
  }
};

exports.down = async function down(knex) {
  for (const [table, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(column));
    }
  }
};
