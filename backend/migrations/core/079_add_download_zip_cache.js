/**
 * Add download ZIP cache columns to events table.
 *
 * Enables pre-generated ZIP files for "Download All" so guests get
 * instant downloads with Content-Length instead of on-the-fly streaming.
 */

exports.up = async function(knex) {
  const hasZipPath = await knex.schema.hasColumn('events', 'download_zip_path');
  if (!hasZipPath) {
    await knex.schema.alterTable('events', (table) => {
      table.text('download_zip_path').nullable().defaultTo(null);
      table.datetime('download_zip_generated_at').nullable().defaultTo(null);
    });
  }
};

exports.down = async function(knex) {
  const hasZipPath = await knex.schema.hasColumn('events', 'download_zip_path');
  if (hasZipPath) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('download_zip_path');
      table.dropColumn('download_zip_generated_at');
    });
  }
};
