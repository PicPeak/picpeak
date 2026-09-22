/**
 * Migration 240: notifications for customer documents (#1444, plan slice 3).
 *
 * One setting, `customer_documents_notify_on_share` (default true): whether
 * sharing a document with a customer emails them a link to it. The admin
 * card's per-action "Notify the customer" checkbox defaults to it. The mail
 * templates themselves are content, not schema — they self-seed at runtime
 * (crmEmailTemplates.ensureCrmEmailTemplatesSeeded).
 *
 * Idempotent: the row is only inserted when missing.
 */

const SETTINGS = [
  { setting_key: 'customer_documents_notify_on_share', setting_value: JSON.stringify(true), setting_type: 'boolean' },
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
