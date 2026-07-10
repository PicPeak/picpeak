/**
 * Migration: Allow admins to pre-fill customer profile fields on invite (#354 follow-up).
 *
 * Adds a single `prefill_data` JSON column to `customer_invitations`. When an
 * admin invites a customer they can optionally pass first/last name, company,
 * phone and a billing address — that data is stashed here and copied onto the
 * new customer_accounts row by acceptInvitation(). The customer can then
 * confirm or edit those values on the accept-invite form before submitting.
 *
 * JSON instead of one column per field because:
 *   - the prefill set may grow (vat id, salutation, etc.) and we don't want a
 *     migration for every UI tweak;
 *   - the data is only ever read+copied wholesale at accept time, never
 *     filtered/queried.
 *
 * Migration is idempotent — bails out if the column already exists.
 */

exports.up = async function(knex) {
  const hasTable = await knex.schema.hasTable('customer_invitations');
  if (!hasTable) {
    // Migration 087 not yet run — nothing to alter. Should never happen in
    // practice (knex runs migrations in order), but be defensive.
    return;
  }

  const hasColumn = await knex.schema.hasColumn('customer_invitations', 'prefill_data');
  if (hasColumn) {
    return;
  }

  await knex.schema.alterTable('customer_invitations', (table) => {
    // Knex's `json` type maps to JSONB on Postgres and TEXT on SQLite, which
    // matches how we already store other free-form payloads in this codebase
    // (see app_settings.theme_config). Nullable: invitations sent the
    // old way (or via the API without a body) should still work.
    table.json('prefill_data');
  });
};

exports.down = async function(knex) {
  const hasTable = await knex.schema.hasTable('customer_invitations');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('customer_invitations', 'prefill_data');
  if (!hasColumn) return;
  await knex.schema.alterTable('customer_invitations', (table) => {
    table.dropColumn('prefill_data');
  });
};
