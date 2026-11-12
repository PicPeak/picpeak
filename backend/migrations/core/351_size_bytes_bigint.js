'use strict';
/**
 * Migration 351: file sizes as 64-bit integers on PostgreSQL (issue 2426).
 *
 * These columns were created with `integer`, which PostgreSQL stores as int4
 * (max 2,147,483,647). A video over 2 GiB failed its photos insert with
 * "out of range for type integer" and was discarded. The same type holds the
 * size of transfer uploads, transfer extra files and customer documents.
 *
 * SQLite is left alone: its INTEGER is already 64-bit, and an `.alter()`
 * there would rebuild the table. db.js creates photos.size_bytes as a
 * bigInteger for new installs. A column that is already bigint is skipped,
 * so a re-run changes nothing.
 */
const COLUMNS = [
  ['photos', 'size_bytes'],
  ['transfer_uploads', 'size_bytes'],
  ['transfer_extra_files', 'size_bytes'],
  ['customer_documents', 'size_bytes'],
];

async function columnType(knex, table, column) {
  const { rows } = await knex.raw(
    'SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?',
    [table, column],
  );
  return rows[0]?.data_type || null;
}

async function retype(knex, from, to) {
  if (knex.client.config.client !== 'pg') return;
  for (const [table, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(table))) continue;
    if ((await columnType(knex, table, column)) !== from) continue;
    await knex.raw(`ALTER TABLE ?? ALTER COLUMN ?? TYPE ${to}`, [table, column]);
  }
}

exports.up = async function up(knex) {
  await retype(knex, 'integer', 'bigint');
};

// Narrowing back fails on any row over 2 GiB, which is what this migration
// exists to store, so down() only reverts while every value still fits.
exports.down = async function down(knex) {
  await retype(knex, 'bigint', 'integer');
};
