/**
 * Migration: Categorise email templates + link them to feature flags.
 *
 * Adds three metadata columns to `email_templates`:
 *
 *   - `category` — top-level display group in the admin Templates UI.
 *     One of:
 *       'core'      — gallery delivery, admin, system, backups.
 *                     Always visible, no feature flag.
 *       'customers' — customer-portal lifecycle (invitation, reset).
 *       'billing'   — Bills feature (#354, not yet built).
 *       'quotes'    — Quotes feature (#354, not yet built).
 *       'calendar'  — Calendar feature (#354, not yet built).
 *     Values outside this set are accepted (forward-compat) but the
 *     UI will lump them under 'core' for now.
 *
 *   - `subcategory` — second-level group inside `core` (which is busy
 *     with 14 templates). One of:
 *       'gallery' — gallery delivery lifecycle (created / expiring /
 *                   expired / archived).
 *       'admin'   — admin lifecycle (invitation, password reset).
 *       'backup'  — DB + file backups (completed / failed) and
 *                   restores.
 *       'system'  — version update notifications.
 *     Only meaningful when category='core'; other categories ignore
 *     it. NULL on rows that don't need a sub-bucket.
 *
 *   - `feature_flag` — name of the feature flag whose `false` value
 *     should mark this template as "Feature off" in the admin UI.
 *     NULL means the template is always active (gallery delivery,
 *     admin lifecycle, system notifications).
 *
 * Categorisation does NOT hide templates. Disabled-feature templates
 * stay visible and editable so admins can prep them before a feature
 * launch; the UI shows a small "Feature off" chip on the entry.
 *
 * Idempotent: re-runs are no-ops.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  const hasCategory = await knex.schema.hasColumn('email_templates', 'category');
  if (!hasCategory) {
    await knex.schema.alterTable('email_templates', (table) => {
      // Default 'core' so existing rows aren't NULL; the backfill below
      // overrides for templates that belong to a feature group.
      table.string('category', 32).notNullable().defaultTo('core');
    });
  }

  const hasSubcategory = await knex.schema.hasColumn('email_templates', 'subcategory');
  if (!hasSubcategory) {
    await knex.schema.alterTable('email_templates', (table) => {
      table.string('subcategory', 32).nullable();
    });
  }

  const hasFeatureFlag = await knex.schema.hasColumn('email_templates', 'feature_flag');
  if (!hasFeatureFlag) {
    await knex.schema.alterTable('email_templates', (table) => {
      table.string('feature_flag', 64).nullable();
    });
  }

  // Backfill — keyed by template_key so we don't accidentally update
  // a row that's been renamed. Templates not in this map keep the
  // 'core' / NULL defaults from the column definitions above.
  const TEMPLATE_METADATA = {
    // Core / Galleries — gallery delivery lifecycle.
    gallery_created:               { category: 'core',      subcategory: 'gallery', feature_flag: null },
    expiration_warning:            { category: 'core',      subcategory: 'gallery', feature_flag: null },
    gallery_expired:               { category: 'core',      subcategory: 'gallery', feature_flag: null },
    archive_complete:              { category: 'core',      subcategory: 'gallery', feature_flag: null },
    // Core / Admin — admin account lifecycle.
    admin_invitation:              { category: 'core',      subcategory: 'admin',   feature_flag: null },
    admin_password_reset:          { category: 'core',      subcategory: 'admin',   feature_flag: null },
    // Core / Backup — database + file backups + restores.
    database_backup_completed:     { category: 'core',      subcategory: 'backup',  feature_flag: null },
    database_backup_failed:        { category: 'core',      subcategory: 'backup',  feature_flag: null },
    restore_completed:             { category: 'core',      subcategory: 'backup',  feature_flag: null },
    restore_failed:                { category: 'core',      subcategory: 'backup',  feature_flag: null },
    backup_completed:              { category: 'core',      subcategory: 'backup',  feature_flag: null },
    backup_failed:                 { category: 'core',      subcategory: 'backup',  feature_flag: null },
    // Core / System — version-update notifications.
    version_update_available:      { category: 'core',      subcategory: 'system',  feature_flag: null },
    version_update_test:           { category: 'core',      subcategory: 'system',  feature_flag: null },
    // Customer portal (#354). Admin-triggered password reset for
    // customer accounts ships in the same feature, so both templates
    // share the `customers` category and the `customerPortal` flag.
    // Future calendar / quotes / bills templates will land here under
    // their own categories.
    customer_invitation:           { category: 'customers', subcategory: null,      feature_flag: 'customerPortal' },
    customer_password_reset:       { category: 'customers', subcategory: null,      feature_flag: 'customerPortal' },
  };

  for (const [key, meta] of Object.entries(TEMPLATE_METADATA)) {
    await knex('email_templates')
      .where({ template_key: key })
      .update({
        category: meta.category,
        subcategory: meta.subcategory,
        feature_flag: meta.feature_flag,
      });
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  if (await knex.schema.hasColumn('email_templates', 'feature_flag')) {
    await knex.schema.alterTable('email_templates', (table) => {
      table.dropColumn('feature_flag');
    });
  }

  if (await knex.schema.hasColumn('email_templates', 'subcategory')) {
    await knex.schema.alterTable('email_templates', (table) => {
      table.dropColumn('subcategory');
    });
  }

  if (await knex.schema.hasColumn('email_templates', 'category')) {
    await knex.schema.alterTable('email_templates', (table) => {
      table.dropColumn('category');
    });
  }
};
