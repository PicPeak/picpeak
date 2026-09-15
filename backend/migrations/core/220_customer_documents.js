/**
 * Migration 220: customer documents in the portal (#1444).
 *
 * Two tables:
 *
 *   customer_documents       One PDF exchanged between the studio and a
 *                            customer. Metadata only; the bytes live in the
 *                            storage backend under
 *                            business-docs/customer-documents/<customer>/<uuid>.pdf
 *                            (a generated key, never the uploaded filename), so
 *                            the .picpeak export and backups pick them up.
 *                            status: pending | clean | rejected. Customer
 *                            uploads start `pending` and stay unavailable for
 *                            download until an admin marks them clean (or a
 *                            scanner does — see documentScanService).
 *   customer_document_views  Who downloaded a document, and when. Lets the
 *                            admin see whether the customer opened a shared
 *                            file. No IP, no user agent.
 *
 * Plus:
 *  - `documents` feature flag, default OFF.
 *  - `customer_accounts.feature_documents` — per-customer override, same
 *    pattern as feature_contracts (migration 131). Defaults TRUE so turning the
 *    master flag on reaches every customer; an admin hides it per customer.
 *  - `customers.documents.manage` permission, granted to super_admin and admin
 *    (the 199 pattern). Other roles start without it.
 *  - Upload limits and retention in app_settings (the 170 pattern).
 *
 * Every step is hasTable/hasColumn-guarded and safe to re-run.
 */

const NEW_PERMISSIONS = [
  {
    name: 'customers.documents.manage',
    display_name: 'Manage Customer Documents',
    category: 'clients',
    description: 'List, upload, share, review and delete documents in a customer\'s portal.',
  },
];

const SETTINGS = [
  { setting_key: 'customer_documents_max_upload_size_mb', setting_value: JSON.stringify(25), setting_type: 'number' },
  { setting_key: 'customer_documents_quota_mb', setting_value: JSON.stringify(250), setting_type: 'number' },
  { setting_key: 'customer_documents_retention_days', setting_value: JSON.stringify(30), setting_type: 'number' },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_documents'))) {
    const hasProjects = await knex.schema.hasTable('projects');
    const hasContracts = await knex.schema.hasTable('contracts');
    await knex.schema.createTable('customer_documents', (t) => {
      t.increments('id').primary();
      // RESTRICT like quotes/contracts: customers are anonymised in place,
      // never hard-deleted, and a cascade would take contractual records
      // with it if that ever changed.
      t.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('RESTRICT');
      t.integer('event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');
      if (hasProjects) {
        t.integer('project_id').unsigned()
          .references('id').inTable('projects').onDelete('SET NULL');
      } else {
        t.integer('project_id').unsigned();
      }
      if (hasContracts) {
        t.integer('contract_id').unsigned()
          .references('id').inTable('contracts').onDelete('SET NULL');
      } else {
        t.integer('contract_id').unsigned();
      }
      // admin | customer. The id is not a foreign key: it points at
      // admin_users or customer_accounts depending on the type, and must
      // survive either row going away.
      t.string('uploader_type', 16).notNullable();
      t.integer('uploader_id').unsigned();
      t.string('original_name', 255).notNullable();
      t.string('storage_key', 512).notNullable().unique();
      t.string('mime_type', 100).notNullable().defaultTo('application/pdf');
      t.integer('size_bytes').notNullable();
      t.string('sha256', 64).notNullable();
      // pending | clean | rejected
      t.string('status', 16).notNullable().defaultTo('pending');
      t.timestamp('reviewed_at');
      t.integer('reviewed_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.string('review_note', 500);
      t.timestamp('shared_at');
      t.timestamp('unshared_at');
      t.timestamp('deleted_at');
      // Set by the retention sweep once the bytes are gone. The row stays as
      // the record that the file existed.
      t.timestamp('purged_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['customer_account_id', 'deleted_at'], 'customer_documents_owner_idx');
      t.index(['status'], 'customer_documents_status_idx');
      t.index(['event_id'], 'customer_documents_event_idx');
    });
  }

  if (!(await knex.schema.hasTable('customer_document_views'))) {
    await knex.schema.createTable('customer_document_views', (t) => {
      t.increments('id').primary();
      t.integer('document_id').unsigned().notNullable()
        .references('id').inTable('customer_documents').onDelete('CASCADE');
      // customer | admin
      t.string('viewer_type', 16).notNullable();
      t.integer('viewer_id').unsigned();
      t.timestamp('viewed_at').defaultTo(knex.fn.now());
      t.index(['document_id'], 'customer_document_views_document_idx');
    });
  }

  if (await knex.schema.hasTable('customer_accounts')
    && !(await knex.schema.hasColumn('customer_accounts', 'feature_documents'))) {
    await knex.schema.alterTable('customer_accounts', (t) => {
      t.boolean('feature_documents').notNullable().defaultTo(true);
    });
  }

  if (await knex.schema.hasTable('app_settings')) {
    for (const s of SETTINGS) {
      const exists = await knex('app_settings').where('setting_key', s.setting_key).first();
      if (!exists) {
        await knex('app_settings').insert({ ...s, updated_at: knex.fn.now() });
      }
    }
  }

  if (await knex.schema.hasTable('feature_flags')) {
    const existingFlag = await knex('feature_flags').where({ key: 'documents' }).first();
    if (!existingFlag) {
      await knex('feature_flags').insert({ key: 'documents', value: false });
    }
  }

  const hasPermissions = await knex.schema.hasTable('permissions');
  const hasRoles = await knex.schema.hasTable('roles');
  const hasRolePermissions = await knex.schema.hasTable('role_permissions');
  if (!hasPermissions || !hasRoles || !hasRolePermissions) return;

  const existing = await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('name');
  const have = new Set(existing.map((r) => r.name));
  const toInsert = NEW_PERMISSIONS.filter((p) => !have.has(p.name));
  if (toInsert.length > 0) {
    await knex('permissions').insert(toInsert);
  }

  const permIds = (await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('id')).map((p) => p.id);
  if (permIds.length === 0) return;

  for (const roleName of ['super_admin', 'admin']) {
    const role = await knex('roles').where({ name: roleName }).first();
    if (!role) continue;
    const granted = await knex('role_permissions')
      .where({ role_id: role.id })
      .whereIn('permission_id', permIds)
      .select('permission_id');
    const hasGrant = new Set(granted.map((r) => r.permission_id));
    const inserts = permIds
      .filter((id) => !hasGrant.has(id))
      .map((id) => ({ role_id: role.id, permission_id: id }));
    if (inserts.length > 0) {
      await knex('role_permissions').insert(inserts);
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('customer_document_views')) {
    await knex.schema.dropTable('customer_document_views');
  }
  if (await knex.schema.hasTable('customer_documents')) {
    await knex.schema.dropTable('customer_documents');
  }
  if (await knex.schema.hasTable('customer_accounts')
    && await knex.schema.hasColumn('customer_accounts', 'feature_documents')) {
    await knex.schema.alterTable('customer_accounts', (t) => t.dropColumn('feature_documents'));
  }
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').whereIn('setting_key', SETTINGS.map((s) => s.setting_key)).del();
  }
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'documents' }).del();
  }
  if (await knex.schema.hasTable('permissions')) {
    const perms = await knex('permissions')
      .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
      .select('id');
    const ids = perms.map((p) => p.id);
    if (ids.length > 0) {
      if (await knex.schema.hasTable('role_permissions')) {
        await knex('role_permissions').whereIn('permission_id', ids).del();
      }
      await knex('permissions').whereIn('id', ids).del();
    }
  }
};
