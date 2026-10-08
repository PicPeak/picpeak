'use strict';

/**
 * Migration 269: team members on a gallery, and review of their uploads
 * (issue 743, phase 2).
 *
 *   event_admin_assignments          admin accounts assigned to an event. An
 *                                    assigned admin reaches the gallery the
 *                                    way its creator does (ownership.js), with
 *                                    its role's permissions as the limit. CRM
 *                                    and transfer data on the event stay the
 *                                    owner's.
 *   events.review_contributor_uploads
 *                                    hold photos an assigned admin uploads
 *                                    until the owner publishes them. Off on
 *                                    every existing event.
 *   photos.moderation_status         NULL = not under review; 'pending' waits
 *                                    for the owner, 'rejected' was turned
 *                                    down. Either way the photo is stored
 *                                    hidden and no gallery viewer sees it.
 *   photos.uploaded_by_admin_id      the admin account that ran an upload.
 *                                    `uploaded_by` keeps meaning admin/guest;
 *                                    watcher and import rows leave this NULL.
 *   admin_users.credit_name          the name an account's uploads are credited
 *                                    with when the file carries no EXIF name.
 *   permission photos.review         approve or reject team uploads on any
 *                                    gallery the holder reaches (a project
 *                                    lead assigned to it), and upload without
 *                                    review. Projected onto the roles that run
 *                                    galleries — photos.edit AND events.edit
 *                                    (admin, editor, solo_photographer, custom
 *                                    roles alike) — and super_admin. Team
 *                                    Photographer holds photos.edit but not
 *                                    events.edit: it is the role whose uploads
 *                                    get reviewed, so it is left out.
 *
 * The FKs cascade on PostgreSQL; SQLite runs without PRAGMA foreign_keys, so
 * the event cascade (adminEvents/helpers.js) and the admin hard delete
 * (userManagementService.js) remove the assignment rows explicitly.
 *
 * Additive and hasTable/hasColumn-guarded throughout.
 */

const REVIEW_PERMISSION = {
  name: 'photos.review',
  display_name: 'Review Team Uploads',
  category: 'photos',
  description: 'Approve or reject photos team members upload to a gallery under review, and upload to it without review.',
};

async function seedReviewPermission(knex) {
  for (const table of ['permissions', 'role_permissions', 'roles']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  if (!(await knex('permissions').where({ name: REVIEW_PERMISSION.name }).first())) {
    await knex('permissions').insert(REVIEW_PERMISSION);
  }
  const review = await knex('permissions').where({ name: REVIEW_PERMISSION.name }).first();
  const superAdmin = await knex('roles').where({ name: 'super_admin' }).first();
  const roleIds = new Set(superAdmin ? [superAdmin.id] : []);
  const holdersOf = async (name) => new Set((await knex('role_permissions')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .where('permissions.name', name)
    .select('role_permissions.role_id')).map((r) => r.role_id));
  const photoEditors = await holdersOf('photos.edit');
  for (const roleId of await holdersOf('events.edit')) {
    if (photoEditors.has(roleId)) roleIds.add(roleId);
  }
  const have = new Set((await knex('role_permissions')
    .where({ permission_id: review.id }).select('role_id')).map((r) => r.role_id));
  const inserts = [...roleIds].filter((id) => !have.has(id))
    .map((roleId) => ({ role_id: roleId, permission_id: review.id }));
  for (let i = 0; i < inserts.length; i += 50) {
    await knex('role_permissions').insert(inserts.slice(i, i + 50));
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_admin_assignments'))
    && await knex.schema.hasTable('events') && await knex.schema.hasTable('admin_users')) {
    await knex.schema.createTable('event_admin_assignments', (t) => {
      t.increments('id').primary();
      t.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      t.integer('admin_user_id').unsigned().notNullable()
        .references('id').inTable('admin_users').onDelete('CASCADE');
      t.integer('assigned_by').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      // Also serves the per-event lookups.
      t.unique(['event_id', 'admin_user_id']);
      // adminAuth reads an admin's assignments on every request.
      t.index(['admin_user_id']);
    });
  }

  if (await knex.schema.hasTable('events')
    && !(await knex.schema.hasColumn('events', 'review_contributor_uploads'))) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('review_contributor_uploads').notNullable().defaultTo(false);
    });
  }

  if (await knex.schema.hasTable('photos')) {
    const hasStatus = await knex.schema.hasColumn('photos', 'moderation_status');
    if (!hasStatus) {
      await knex.schema.alterTable('photos', (t) => {
        t.string('moderation_status', 16).nullable();
        // The review banner counts and the filter list by event.
        t.index(['event_id', 'moderation_status'], 'photos_event_moderation_idx');
      });
    }
    if (!(await knex.schema.hasColumn('photos', 'uploaded_by_admin_id'))) {
      await knex.schema.alterTable('photos', (t) => {
        t.integer('uploaded_by_admin_id').unsigned().nullable()
          .references('id').inTable('admin_users').onDelete('SET NULL');
      });
    }
  }

  if (await knex.schema.hasTable('admin_users')
    && !(await knex.schema.hasColumn('admin_users', 'credit_name'))) {
    await knex.schema.alterTable('admin_users', (t) => {
      t.string('credit_name', 100).nullable();
    });
  }

  await seedReviewPermission(knex);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('permissions') && await knex.schema.hasTable('role_permissions')) {
    const review = await knex('permissions').where({ name: REVIEW_PERMISSION.name }).first();
    if (review) {
      await knex('role_permissions').where({ permission_id: review.id }).del();
      await knex('permissions').where({ id: review.id }).del();
    }
  }
  // Dropping a column drops its FK on PostgreSQL; SQLite has no constraint
  // to drop.
  const drop = async (table, cols) => {
    if (!(await knex.schema.hasTable(table))) return;
    for (const col of cols) {
      if (await knex.schema.hasColumn(table, col)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(col));
      }
    }
  };
  await knex.raw('DROP INDEX IF EXISTS photos_event_moderation_idx');
  await drop('photos', ['moderation_status', 'uploaded_by_admin_id']);
  await drop('events', ['review_contributor_uploads']);
  await drop('admin_users', ['credit_name']);
  await knex.schema.dropTableIfExists('event_admin_assignments');
};

// The boot self-heal (services/_permissionsBoot.js) re-seeds the permission
// after a restore of a backup taken before this migration.
exports.seedReviewPermission = seedReviewPermission;
