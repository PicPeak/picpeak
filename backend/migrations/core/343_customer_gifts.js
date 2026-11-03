/**
 * Migration 343: customer gifts and gift stock.
 *
 * Three tables:
 *
 *   gift_items             The catalogue: what can be given. Generic on
 *                          purpose, PicPeak knows nothing about what an item
 *                          is. Archived, never deleted, once it has been used.
 *   gift_stock_movements   Every change to an item's stock. The count is the
 *                          sum of `quantity_delta`, so no stored total can
 *                          drift from the history behind it.
 *   customer_gifts         What an admin decided for a customer: a gift given
 *                          or a milestone declined. Suggestions are worked
 *                          out from paid invoices when the list loads, so only
 *                          decisions are stored. Undoing keeps the row and
 *                          sets `undone_at`.
 *
 * Two columns on customer_accounts: `gift_start_date_override`, for a
 * relationship older than its first invoice, and `no_gifts`.
 *
 * Behind the `customerGifts` flag, off by default. Reading needs
 * `customers.gifts.view`, every change needs `customers.gifts.manage`, granted
 * to super_admin and admin (the 226 pattern).
 *
 * Every step is guarded and safe to re-run.
 */

const NEW_PERMISSIONS = [
  {
    name: 'customers.gifts.view',
    display_name: 'View Customer Gifts',
    category: 'clients',
    description: 'See gift suggestions, gift stock and the gift history on customers.',
  },
  {
    name: 'customers.gifts.manage',
    display_name: 'Manage Customer Gifts',
    category: 'clients',
    description: 'Give and decline gifts, manage gift items and stock, and change the gift rules.',
  },
];

const MILESTONE_INDEX = 'customer_gifts_active_milestone_uq';

const SETTING_KEYS = [
  'gift_milestone_years', 'gift_min_bookings', 'gift_activity_min_invoices',
  'gift_activity_period_years', 'gift_rhythm_margin_months', 'gift_grace_days',
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('gift_items'))) {
    await knex.schema.createTable('gift_items', (t) => {
      t.increments('id').primary();
      t.string('name', 120).notNullable();
      t.string('description', 500);
      t.boolean('is_archived').notNullable().defaultTo(false);
      t.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('customer_gifts'))) {
    await knex.schema.createTable('customer_gifts', (t) => {
      t.increments('id').primary();
      t.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      t.integer('gift_item_id').unsigned()
        .references('id').inTable('gift_items').onDelete('RESTRICT');
      // 'given' | 'declined'. A decline has no item and moves no stock.
      t.string('status', 16).notNullable();
      // Set when the entry closes a milestone; null for a gift by hand.
      t.integer('milestone_years');
      // Given although the rules said no ("Gift anyway").
      t.boolean('is_override').notNullable().defaultTo(false);
      t.bigInteger('unit_cost_minor');
      t.string('currency', 3);
      t.text('note');
      t.date('gift_date').notNullable();
      t.timestamp('undone_at');
      t.integer('undone_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['customer_account_id'], 'customer_gifts_customer_idx');
    });
  }

  // One live decision per customer and milestone; the 291 pattern.
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${MILESTONE_INDEX} `
    + 'ON customer_gifts (customer_account_id, milestone_years) '
    + 'WHERE undone_at IS NULL AND milestone_years IS NOT NULL',
  );

  if (!(await knex.schema.hasTable('gift_stock_movements'))) {
    await knex.schema.createTable('gift_stock_movements', (t) => {
      t.increments('id').primary();
      t.integer('gift_item_id').unsigned().notNullable()
        .references('id').inTable('gift_items').onDelete('RESTRICT');
      // 'purchase' | 'gift' | 'gift_undone' | 'correction'
      t.string('kind', 16).notNullable();
      t.integer('quantity_delta').notNullable();
      t.bigInteger('unit_cost_minor');
      t.string('currency', 3);
      // The supplier invoice this purchase came in on. The document stays the
      // accounting record, so the cost is booked once.
      t.integer('inbound_document_id').unsigned()
        .references('id').inTable('inbound_documents').onDelete('SET NULL');
      // Keeps the count right when a customer's gift rows go with the account.
      t.integer('customer_gift_id').unsigned()
        .references('id').inTable('customer_gifts').onDelete('SET NULL');
      t.string('reason', 500);
      t.date('occurred_on').notNullable();
      t.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['gift_item_id'], 'gift_stock_movements_item_idx');
    });
  }

  if (!(await knex.schema.hasColumn('customer_accounts', 'gift_start_date_override'))) {
    await knex.schema.alterTable('customer_accounts', (t) => {
      t.date('gift_start_date_override');
    });
  }
  if (!(await knex.schema.hasColumn('customer_accounts', 'no_gifts'))) {
    await knex.schema.alterTable('customer_accounts', (t) => {
      t.boolean('no_gifts').notNullable().defaultTo(false);
    });
  }

  if (await knex.schema.hasTable('feature_flags')) {
    const existing = await knex('feature_flags').where({ key: 'customerGifts' }).first();
    if (!existing) await knex('feature_flags').insert({ key: 'customerGifts', value: false });
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
  if (await knex.schema.hasTable('gift_stock_movements')) {
    await knex.schema.dropTable('gift_stock_movements');
  }
  if (await knex.schema.hasTable('customer_gifts')) {
    await knex.schema.dropTable('customer_gifts');
  }
  if (await knex.schema.hasTable('gift_items')) {
    await knex.schema.dropTable('gift_items');
  }
  if (await knex.schema.hasColumn('customer_accounts', 'gift_start_date_override')) {
    await knex.schema.alterTable('customer_accounts', (t) => { t.dropColumn('gift_start_date_override'); });
  }
  if (await knex.schema.hasColumn('customer_accounts', 'no_gifts')) {
    await knex.schema.alterTable('customer_accounts', (t) => { t.dropColumn('no_gifts'); });
  }
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'customerGifts' }).del();
  }
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').whereIn('setting_key', SETTING_KEYS).del();
  }
  if (await knex.schema.hasTable('permissions')) {
    const ids = (await knex('permissions')
      .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
      .select('id')).map((p) => p.id);
    if (ids.length > 0 && await knex.schema.hasTable('role_permissions')) {
      await knex('role_permissions').whereIn('permission_id', ids).del();
    }
    await knex('permissions').whereIn('name', NEW_PERMISSIONS.map((p) => p.name)).del();
  }
};
