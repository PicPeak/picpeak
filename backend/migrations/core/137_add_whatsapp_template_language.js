/**
 * Migration 137: WhatsApp template language (#647).
 *
 * Adds a `template_language` column to `whatsapp_configs` so admins can
 * pin their Meta-approved template's language code (e.g. `ar`, `en_US`,
 * `de_DE`) directly in Settings → WhatsApp. Without this column the only
 * resolution paths were per-message `data.language` (always null in our
 * own callers) and `app_settings.general_default_language` — both of
 * which are tied to the *system* UI language, not the *template's* language
 * registered with Meta. Reporter @Rekoo-PS hit this with an Arabic
 * template against the test-send route.
 *
 * Additive + hasColumn-guarded. Empty string default means "fall through
 * to general_default_language" — preserves current behaviour for installs
 * that don't set it.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('whatsapp_configs'))) return;
  if (await knex.schema.hasColumn('whatsapp_configs', 'template_language')) return;
  await knex.schema.alterTable('whatsapp_configs', (table) => {
    table.string('template_language', 20).notNullable().defaultTo('');
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('whatsapp_configs'))) return;
  if (!(await knex.schema.hasColumn('whatsapp_configs', 'template_language'))) return;
  await knex.schema.alterTable('whatsapp_configs', (table) => {
    table.dropColumn('template_language');
  });
};
