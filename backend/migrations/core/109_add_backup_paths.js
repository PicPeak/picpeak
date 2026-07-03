/**
 * Migration 109 — config-driven backup walker.
 *
 * (Originally numbered 108 on bugfix/crm-backup. Renumbered to 109
 * before merge because upstream/beta independently shipped
 * 108_seed_sl_email_template_translations.js. The createTable is
 * idempotent via `hasTable` guard and the seed uses
 * `onConflict('path').ignore()`, so beta installs that ran the
 * 108-named version of this file get a harmless no-op when 109
 * runs against the already-seeded table.)
 *
 * Stage B of the three-stage backup-hardening plan. The file-backup
 * walker (`getFilesToBackupInternal` in backupService.js) historically
 * hard-coded its list of subdirectories: events/active, events/archived,
 * thumbnails, previews, heroes, uploads, business-docs.
 *
 * That list is a footgun every time a new feature lands that drops
 * artefacts under STORAGE_PATH/<something>/ — the maintainer has to
 * remember to edit the walker, and there's no schema-level record of
 * what *should* be backed up. The CRM rollout missed `business-docs`
 * for ~6 months (#XXX) for exactly this reason.
 *
 * This migration introduces a `backup_paths` table that the walker
 * reads at runtime. New features add a row; the walker picks them up
 * automatically. The `feature_flag` column gates scans behind an
 * existing app_settings boolean (e.g. `backup_include_archived`),
 * mirroring how the previous `includeArchived` parameter worked.
 *
 * Columns:
 *   - path                : relative to STORAGE_PATH, unique
 *   - include_in_default  : on/off without deleting the row (so
 *                           audit trail of "we used to back this up"
 *                           is preserved)
 *   - feature_flag        : nullable; when set, walker checks the
 *                           same-named app_settings boolean before
 *                           scanning. Matches the existing pattern
 *                           used by `backup_include_archived`.
 *   - display_order       : controls admin-UI listing order
 *   - description         : human-readable purpose, shown in admin UI
 *
 * Defense-in-depth: the walker also keeps a hard-coded LEGACY_DEFAULTS
 * fallback so that if this table is somehow empty (failed migration on
 * an existing install, manual truncation), backups still cover the
 * historical set instead of silently shipping nothing. The boot-time
 * self-heal in `_backupPathsBoot.js` re-seeds missing default rows on
 * every startup so newly-added defaults reach already-deployed
 * installs without a follow-up migration.
 *
 * Idempotent: skips the createTable if it already exists, and the
 * seed uses `onConflict('path').ignore()` so re-runs don't duplicate.
 */

const DEFAULT_PATHS = [
  {
    path: 'events/active',
    include_in_default: true,
    feature_flag: null,
    display_order: 10,
    description: 'Active gallery photo originals',
  },
  {
    path: 'events/archived',
    include_in_default: true,
    feature_flag: 'backup_include_archived',
    display_order: 20,
    description: 'Archived gallery photo originals (gated by backup_include_archived)',
  },
  {
    path: 'thumbnails',
    include_in_default: true,
    feature_flag: null,
    display_order: 30,
    description: 'Generated gallery thumbnails',
  },
  {
    path: 'previews',
    include_in_default: true,
    feature_flag: null,
    display_order: 40,
    description: 'Lightbox preview tier (#492)',
  },
  {
    path: 'heroes',
    include_in_default: true,
    feature_flag: null,
    display_order: 50,
    description: 'Gallery hero header images',
  },
  {
    path: 'uploads',
    include_in_default: true,
    feature_flag: null,
    display_order: 60,
    description: 'Direct uploads root (wet-signature contracts, imported invoices, etc.)',
  },
  {
    path: 'business-docs',
    include_in_default: true,
    feature_flag: null,
    display_order: 70,
    description: 'CRM PDFs, signature artefacts, admin-imported historical invoices',
  },
];

exports.up = async function(knex) {
  const exists = await knex.schema.hasTable('backup_paths');
  if (!exists) {
    await knex.schema.createTable('backup_paths', (t) => {
      t.increments('id').primary();
      t.string('path', 256).notNullable().unique();
      t.boolean('include_in_default').notNullable().defaultTo(true);
      t.string('feature_flag', 64).nullable();
      t.integer('display_order').notNullable().defaultTo(100);
      t.string('description', 256).nullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  // Seed defaults — `onConflict('path').ignore()` so already-seeded rows
  // (manual edits by admins, prior partial runs) survive untouched.
  await knex('backup_paths')
    .insert(DEFAULT_PATHS.map((row) => ({
      ...row,
      created_at: new Date(),
      updated_at: new Date(),
    })))
    .onConflict('path')
    .ignore();
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('backup_paths');
};

// Exported so the self-heal boot helper can reuse the same authoritative
// list without re-declaring it. Tests also import this to assert the
// walker is reading from this source.
exports.DEFAULT_PATHS = DEFAULT_PATHS;
