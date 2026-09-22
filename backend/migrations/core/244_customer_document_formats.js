/**
 * Migration 244: which document formats customers may upload (#1444, plan
 * slice 7).
 *
 * `customer_documents_allowed_formats`, a JSON array drawn from the fixed
 * allowlist in services/documentFormats (pdf, docx, xlsx, odt, ods, txt,
 * csv). Seeded as ["pdf"], so an upgrade changes nothing until an admin
 * opts in to more (Settings → CRM → Customer documents).
 *
 * Idempotent: the row is only inserted when missing; down() removes it,
 * which the code reads as ["pdf"] again.
 */

const SETTINGS = [
  { setting_key: 'customer_documents_allowed_formats', setting_value: JSON.stringify(['pdf']), setting_type: 'crm' },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  for (const s of SETTINGS) {
    const exists = await knex('app_settings').where('setting_key', s.setting_key).first();
    if (!exists) await knex('app_settings').insert({ ...s, updated_at: knex.fn.now() });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  await knex('app_settings').whereIn('setting_key', SETTINGS.map((s) => s.setting_key)).del();
};
