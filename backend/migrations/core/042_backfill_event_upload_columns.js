const logger = require('../../src/utils/logger');

async function ensureColumn(knex, tableName, columnName, alterFn) {
  const exists = await knex.schema.hasColumn(tableName, columnName);
  if (!exists) {
    logger.info(`Adding column ${tableName}.${columnName}`);
    await knex.schema.table(tableName, alterFn);
  }
}

exports.up = async function(knex) {
  await ensureColumn(knex, 'events', 'host_name', (table) => {
    table.string('host_name');
  });

  await ensureColumn(knex, 'events', 'allow_user_uploads', (table) => {
    table.boolean('allow_user_uploads').defaultTo(false);
  });

  await ensureColumn(knex, 'events', 'upload_category_id', (table) => {
    table.integer('upload_category_id');
  });

  await ensureColumn(knex, 'events', 'allow_downloads', (table) => {
    table.boolean('allow_downloads').defaultTo(true);
  });

  await ensureColumn(knex, 'events', 'disable_right_click', (table) => {
    table.boolean('disable_right_click').defaultTo(false);
  });

  await ensureColumn(knex, 'events', 'watermark_downloads', (table) => {
    table.boolean('watermark_downloads').defaultTo(false);
  });

  await ensureColumn(knex, 'events', 'watermark_text', (table) => {
    table.text('watermark_text');
  });

  await ensureColumn(knex, 'events', 'hero_photo_id', (table) => {
    table.integer('hero_photo_id').references('id').inTable('photos').onDelete('SET NULL');
  });

  await ensureColumn(knex, 'photos', 'uploaded_by', (table) => {
    table.string('uploaded_by').defaultTo('admin');
  });
};

exports.down = async function() {
  // Non destructive migration; no rollback
};
