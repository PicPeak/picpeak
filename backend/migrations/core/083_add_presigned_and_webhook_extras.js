/**
 * Adds:
 *   - events.allow_presigned_download — per-event opt-in for the
 *     presigned-URL "Download All" path (#328 follow-up). Off by default
 *     because it bypasses watermarks; admins flip it knowingly.
 *   - webhooks.filter — JSONB predicate evaluated against the payload at
 *     fire time (#327 follow-up). Empty object = no filter, fire always.
 *   - webhooks.template — optional ${dot.path} string template applied
 *     to the request body before signing. NULL = use the default JSON
 *     envelope (back-compat).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events')) {
    const hasCol = await knex.schema.hasColumn('events', 'allow_presigned_download');
    if (!hasCol) {
      await knex.schema.alterTable('events', (table) => {
        table.boolean('allow_presigned_download').notNullable().defaultTo(false);
      });
    }
  }

  if (await knex.schema.hasTable('webhooks')) {
    const hasFilter = await knex.schema.hasColumn('webhooks', 'filter');
    if (!hasFilter) {
      await knex.schema.alterTable('webhooks', (table) => {
        table.jsonb('filter').notNullable().defaultTo('{}');
      });
    }
    const hasTemplate = await knex.schema.hasColumn('webhooks', 'template');
    if (!hasTemplate) {
      await knex.schema.alterTable('webhooks', (table) => {
        table.text('template').nullable();
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('webhooks', 'template')) {
    await knex.schema.alterTable('webhooks', (t) => t.dropColumn('template'));
  }
  if (await knex.schema.hasColumn('webhooks', 'filter')) {
    await knex.schema.alterTable('webhooks', (t) => t.dropColumn('filter'));
  }
  if (await knex.schema.hasColumn('events', 'allow_presigned_download')) {
    await knex.schema.alterTable('events', (t) => t.dropColumn('allow_presigned_download'));
  }
};
