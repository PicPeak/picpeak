/**
 * Emails take the brand's filled accent (Branding › Colours) from now on
 * when Settings → Email sets no Primary colour (emailProcessor
 * resolveEmailAccent), and the green the seeded templates carry inline
 * follows that accent.
 *
 * An install that has already been in use keeps the look its recipients
 * know: it gets the old green pinned as its email Primary colour, unless it
 * set one already. The button label needs no pin — with no label configured
 * the mailer keeps white on the green or any configured Primary, and derives
 * one only for an accent taken from Branding. The admin can clear the Primary
 * in Settings → Email to follow the brand. A fresh install follows the brand
 * from its first mail.
 */

const { sanitizeCssColor } = require('../../src/utils/cssSanitizer');

const LEGACY_EMAIL_GREEN = '#5C8762';

function stored(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : '';
  } catch (_) {
    return value;
  }
}

async function hasRow(knex, table) {
  if (!(await knex.schema.hasTable(table))) return false;
  return Boolean(await knex(table).first());
}

/**
 * Whether this install was in use before the upgrade. email_queue alone is
 * not durable: its rows are deleted with their event (adminEvents/helpers),
 * so a long-running install that pruned its events would look fresh. The
 * signals, any of which counts:
 *
 *  - setup_wizard_completed is not `false`. Migration 161 seeds it false only
 *    on an install without an admin, and the wizard flips it true; a fresh
 *    install reaches this migration before its wizard ran. A missing row
 *    means app_settings came back from a backup that predates 161 — a
 *    configured instance, as setupService.isSetupWizardCompleted reads it.
 *  - an email_queue or events row, for good measure.
 *
 * Not the SMTP settings: migration 001 seeds email_configs from SMTP_HOST
 * on a fresh install, so a configured transport says nothing about age.
 */
async function wasInUse(knex) {
  const flag = await knex('app_settings').where({ setting_key: 'setup_wizard_completed' }).first('setting_value');
  if (!flag) return true;
  let completed = flag.setting_value;
  if (typeof completed === 'string') {
    try { completed = JSON.parse(completed); } catch (_) { /* a raw string is not `false` */ }
  }
  if (completed !== false) return true;
  return (await hasRow(knex, 'email_queue')) || (await hasRow(knex, 'events'));
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  if (!(await wasInUse(knex))) return;

  const row = await knex('app_settings').where({ setting_key: 'email_primary_color' }).first('setting_value');
  // Only a value the mailer would use counts as set (emailProcessor
  // readColor): an invalid one fell back to the green, so it is pinned too.
  if (row && sanitizeCssColor(stored(row.setting_value))) return;

  const value = JSON.stringify(LEGACY_EMAIL_GREEN);
  if (row) {
    await knex('app_settings').where({ setting_key: 'email_primary_color' }).update({ setting_value: value, updated_at: new Date().toISOString() });
  } else {
    await knex('app_settings').insert({ setting_key: 'email_primary_color', setting_value: value, setting_type: 'general', updated_at: new Date().toISOString() });
  }
};

// The pinned value is indistinguishable from one the admin set, so it stays.
exports.down = async function () {};
