/**
 * Small helper to read app_settings rows.
 *
 * The picpeak codebase has TWO settings services:
 *   - `src/services/settingsService.js` queries a `settings` table that
 *     doesn't actually exist on most deployments (legacy SQLite-era
 *     name). Calling getSetting() from there raises
 *     "relation \"settings\" does not exist" on Postgres.
 *   - The canonical store is `app_settings`, accessed inline by every
 *     other service (shareLinkService, customerAccountsService,
 *     authSecurity, dateFormatter, …).
 *
 * The CRM services use this helper instead of settingsService so the
 * crm_* keys seeded by migration 102 are actually readable.
 */

const { db } = require('../database/db');

/**
 * Read a single app_settings row by key. Returns the parsed value or
 * `defaultValue` when the key doesn't exist.
 *
 * `setting_value` is always JSON-stringified at write time
 * (see migration 102 + the /admin/settings/general route), so we
 * JSON.parse on the way out. Falls back to the raw string on
 * malformed JSON so legacy text values still work.
 */
async function getAppSetting(key, defaultValue = null, conn = db) {
  // Callers reading from inside a knex transaction must pass that trx as
  // `conn`, otherwise the global-`db` read grabs a second connection from
  // the single-connection SQLite pool while the trx holds it → deadlock.
  const row = await conn('app_settings').where({ setting_key: key }).first();
  if (!row || row.setting_value == null) return defaultValue;
  try {
    return JSON.parse(row.setting_value);
  } catch (_) {
    return row.setting_value;
  }
}

/**
 * Schema-correct upsert into app_settings. The table has NO `created_at`
 * column (only setting_key/setting_value/setting_type + updated_at — see
 * src/database/db.js), so inserting created_at throws and silently breaks the
 * FIRST save of any new key. Centralised here so route authors can't
 * re-introduce that bug (PR #622 concern 5). `setting_value` is expected to be
 * already JSON-stringified, matching getAppSetting's JSON.parse on read.
 */
async function upsertAppSetting(setting_key, setting_value, setting_type, conn = db) {
  const existing = await conn('app_settings').where({ setting_key }).first();
  if (existing) {
    await conn('app_settings').where({ setting_key })
      .update({ setting_value, setting_type, updated_at: new Date() });
  } else {
    await conn('app_settings').insert({ setting_key, setting_value, setting_type, updated_at: new Date() });
  }
}

module.exports = { getAppSetting, upsertAppSetting };
