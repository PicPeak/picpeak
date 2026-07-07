/**
 * Migration 135: per-category download permissions (#640).
 *
 * Adds an `allow_downloads` boolean to `photo_categories` so admins can have
 * different download policies per category (e.g. preview categories public,
 * originals client-only). The flag is an AND with the event-level
 * `allow_downloads`: a category download is allowed only when BOTH the
 * event AND the category say yes. Defaults to true so existing categories
 * keep working without admin intervention.
 *
 * Additive + hasColumn-guarded.
 */
async function addColumn(knex, table, column, builder) {
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, builder);
  }
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return;
  await addColumn(knex, 'photo_categories', 'allow_downloads', (t) =>
    t.boolean('allow_downloads').notNullable().defaultTo(true)
  );
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('photo_categories'))) return;
  if (await knex.schema.hasColumn('photo_categories', 'allow_downloads')) {
    await knex.schema.alterTable('photo_categories', (t) =>
      t.dropColumn('allow_downloads')
    );
  }
};
