/**
 * Migration: re-add the configurable upload batch size setting (#509).
 *
 * Originally shipped via PR #214 (#208 fix) — users behind Cloudflare
 * Tunnel and other reverse proxies with per-request size caps need to
 * bound the chunked-upload size so they don't lose every batch >100MB.
 * That migration + frontend wiring was lost during a `Merge main into
 * beta for release/beta-to-main` resolution that picked main's older
 * tree over beta's, silently deleting the file and reinstating the
 * hardcoded 500MB chunk in PhotoUpload.tsx.
 *
 * Re-introducing the exact same migration here. Idempotent: skips the
 * insert if the row already exists (e.g. installs that did go through
 * the original 072 between #214 merge and the main-into-beta merge,
 * where the migrations-table row was preserved even after the file
 * was deleted).
 */

exports.up = async function(knex) {
  const exists = await knex('app_settings')
    .where({ setting_key: 'general_max_upload_batch_size_mb' })
    .first();

  if (!exists) {
    await knex('app_settings').insert({
      setting_key: 'general_max_upload_batch_size_mb',
      setting_value: JSON.stringify(95),
      setting_type: 'general',
      updated_at: new Date()
    });
  }
};

exports.down = async function(knex) {
  await knex('app_settings')
    .where({ setting_key: 'general_max_upload_batch_size_mb' })
    .del();
};
