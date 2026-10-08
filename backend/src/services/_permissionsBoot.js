/**
 * Boot-time self-heal for the RBAC permission catalog.
 *
 * The single durable guarantee here: the `super_admin` role holds EVERY
 * permission currently defined. This is the "Admin tracks all" mechanism —
 * whenever a future release adds a permission (via its migration), this boot
 * pass grants it to super_admin automatically, so a new perm never needs a
 * compensation migration and the owner is never locked out of a new feature.
 * See feedback_self_heal_pattern + project_permission_gating.
 *
 * Deliberately NARROW: it only ever backfills `super_admin`. All other roles —
 * admin, editor, viewer, the solo_photographer preset, and any custom roles an
 * org creates — are FROZEN: new perms default OFF for them so nobody silently
 * gains a capability (e.g. the ability to change IBAN/domains) on upgrade. The
 * owner grants those explicitly via the role editor.
 *
 * The solo_photographer preset itself is seeded (with all-perms-at-seed-time) by
 * migration 175; this pass only ensures it exists so a partially-migrated or
 * hand-restored DB still shows the preset. Its grants are never re-synced.
 *
 * Idempotent and best-effort: any failure is logged and swallowed so a boot is
 * never blocked by permission housekeeping.
 */

const { CUSTOMER_SUPPORT } = require('../../migrations/core/259_gallery_admin_cleanup');

// Preset roles shipped with the app. `permissions: 'ALL'` = every current perm.
// Kept in sync with migration 175 (PRESET_ROLES) and 259 (customer_support). This boot pass only ensures a
// preset EXISTS (create + grant if missing) so a partially-migrated or restored
// DB still shows it; it never re-syncs an existing preset's grants (frozen).
const PRESETS = [
  {
    name: 'solo_photographer',
    display_name: 'Solo Photographer',
    description: 'Full operator for a one-person studio — everything needed to run the business. A preset starting point; new-release permissions are not auto-added (only Super Admin tracks all).',
    is_system: true,
    priority: 90,
    permissions: 'ALL',
  },
  {
    name: 'team_photographer',
    display_name: 'Team Photographer',
    description: 'Contributing photographer (second/festival shooter) — view events, upload and manage photos, and see read-only client context. Not the customer contact: no settings, user management, billing edits or event configuration. A preset starting point.',
    is_system: true,
    priority: 40,
    permissions: [
      'events.view',
      'photos.view', 'photos.upload', 'photos.edit', 'photos.download',
      'customers.view', 'quotes.view', 'bills.view',
    ],
  },
  CUSTOMER_SUPPORT,
];

async function ensureSuperAdminHasAllPermissions(db, logger) {
  const superAdmin = await db('roles').where({ name: 'super_admin' }).first();
  if (!superAdmin) return 0;

  const allPerms = await db('permissions').select('id');
  if (allPerms.length === 0) return 0;

  const held = await db('role_permissions')
    .where({ role_id: superAdmin.id })
    .select('permission_id');
  const heldSet = new Set(held.map((r) => r.permission_id));

  const inserts = allPerms
    .filter((p) => !heldSet.has(p.id))
    .map((p) => ({ role_id: superAdmin.id, permission_id: p.id }));

  if (inserts.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < inserts.length; i += batchSize) {
      await db('role_permissions').insert(inserts.slice(i, i + batchSize));
    }
    logger?.info?.(`Permissions self-heal: granted ${inserts.length} missing permission(s) to super_admin`);
  }
  return inserts.length;
}

async function ensurePreset(db, logger, preset) {
  const existing = await db('roles').where({ name: preset.name }).first();
  if (existing) return; // frozen — never re-sync its grants

  // A listed preset whose permissions are not all in the catalog yet (the
  // server started against a database its migrations have not reached) is
  // left for the migration that adds them. Seeding it now would freeze it
  // with a partial grant set: the migration skips a preset that exists.
  let listed = null;
  if (preset.permissions !== 'ALL') {
    listed = await db('permissions').whereIn('name', preset.permissions).select('id');
    if (listed.length < preset.permissions.length) return;
  }

  await db('roles').insert({
    name: preset.name,
    display_name: preset.display_name,
    description: preset.description,
    is_system: preset.is_system,
    priority: preset.priority,
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  });
  const role = await db('roles').where({ name: preset.name }).first();
  if (!role) return;

  let permIds;
  if (preset.permissions === 'ALL') {
    permIds = (await db('permissions').select('id')).map((p) => p.id);
  } else {
    permIds = listed.map((p) => p.id);
  }
  if (permIds.length > 0) {
    const inserts = permIds.map((id) => ({ role_id: role.id, permission_id: id }));
    const batchSize = 50;
    for (let i = 0; i < inserts.length; i += batchSize) {
      await db('role_permissions').insert(inserts.slice(i, i + batchSize));
    }
  }
  logger?.info?.(`Permissions self-heal: seeded missing ${preset.name} preset (${permIds.length} permissions)`);
}

async function seedPermissionsAtBoot(db, logger) {
  try {
    const hasRoles = await db.schema.hasTable('roles');
    const hasPerms = await db.schema.hasTable('permissions');
    const hasRolePerms = await db.schema.hasTable('role_permissions');
    if (!hasRoles || !hasPerms || !hasRolePerms) return;

    // Per-step try/catch: on a multi-replica start the loser of a
    // role_permissions insert race can throw a PK violation in one step; that
    // must not skip the remaining steps (e.g. preset seeding) on that replica.
    let granted = 0;
    try {
      granted = await ensureSuperAdminHasAllPermissions(db, logger);
    } catch (err) {
      logger?.warn?.('Permissions self-heal: super_admin backfill failed:', err.message);
    }
    // folders.manage (migration 265) is gone after restoring a backup taken
    // before it; re-seed it and its projection onto settings.edit holders,
    // or folder editing would silently need super_admin.
    try {
      if (!(await db('permissions').where({ name: 'folders.manage' }).first('id'))) {
        await require('../../migrations/core/265_nested_folders_and_delivery_stages').seedFolderPermissions(db);
        granted += 1;
        logger?.info?.('Permissions self-heal: re-seeded folders.manage');
      }
    } catch (err) {
      logger?.warn?.('Permissions self-heal: folders.manage failed:', err.message);
    }
    // photos.review (migration 269), the same way: without it every
    // reviewer's uploads would start being held after such a restore.
    try {
      if (!(await db('permissions').where({ name: 'photos.review' }).first('id'))) {
        await require('../../migrations/core/269_event_admin_assignments_and_upload_review').seedReviewPermission(db);
        granted += 1;
        logger?.info?.('Permissions self-heal: re-seeded photos.review');
      }
    } catch (err) {
      logger?.warn?.('Permissions self-heal: photos.review failed:', err.message);
    }
    for (const preset of PRESETS) {
      try {
        await ensurePreset(db, logger, preset);
      } catch (err) {
        logger?.warn?.(`Permissions self-heal: preset ${preset.name} failed:`, err.message);
      }
    }

    if (granted > 0) {
      // Drop the in-memory permission cache so the new grants take effect
      // without waiting out the 60s TTL.
      try {
        const { clearPermissionCache } = require('../middleware/permissions');
        clearPermissionCache?.();
      } catch (_) { /* cache module optional at boot */ }
    }
  } catch (err) {
    logger?.warn?.('Permissions self-heal failed at boot:', err.message);
  }
}

module.exports = { seedPermissionsAtBoot };
