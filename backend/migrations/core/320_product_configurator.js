'use strict';
/** Native, opt-in product choices (#1924). Historical choices are snapshots. */
exports.up = async function (db) {
  if (!(await db.schema.hasTable('album_product_catalogue'))) {
    await db.schema.createTable('album_product_catalogue', (t) => {
      t.integer('id').primary();
      t.integer('revision').notNullable();
      t.text('products').notNullable();
      t.timestamp('updated_at').notNullable();
    });
  }
  await db('album_product_catalogue')
    .insert({
      id: 1,
      revision: 0,
      products: '[]',
      updated_at: new Date().toISOString(),
    })
    .onConflict('id')
    .ignore();
  if (!(await db.schema.hasTable('album_product_images'))) {
    await db.schema.createTable('album_product_images', (t) => {
      t.string('id', 36).primary();
      t.string('storage_key', 512).notNullable().unique();
      t.string('sha256', 64).notNullable();
      t.integer('width').notNullable();
      t.integer('height').notNullable();
      t.integer('created_by')
        .unsigned()
        .references('id')
        .inTable('admin_users')
        .onDelete('SET NULL');
      t.timestamp('created_at').notNullable();
    });
  }
  if (!(await db.schema.hasTable('event_album_products'))) {
    await db.schema.createTable('event_album_products', (t) => {
      t.string('id', 36).primary();
      t.integer('event_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('events')
        .onDelete('CASCADE');
      t.string('product_id', 36).notNullable();
      t.unique(['event_id', 'product_id']);
      t.boolean('enabled').notNullable().defaultTo(true);
      t.integer('revision').notNullable().defaultTo(1);
      t.string('status', 16).notNullable().defaultTo('draft');
      t.text('selection');
      t.timestamp('created_at').notNullable();
      t.timestamp('updated_at').notNullable();
    });
  }
  if (!(await db.schema.hasTable('album_product_choice_history'))) {
    await db.schema.createTable('album_product_choice_history', (t) => {
      t.string('id', 36).primary();
      t.string('offer_id', 36)
        .notNullable()
        .references('id')
        .inTable('event_album_products')
        .onDelete('CASCADE');
      t.integer('revision').notNullable();
      t.unique(['offer_id', 'revision']);
      t.string('mutation_id', 36).notNullable();
      t.unique(['offer_id', 'mutation_id']);
      t.string('status', 16).notNullable();
      t.text('selection');
      t.string('actor_type', 16).notNullable();
      t.string('actor_id', 80);
      t.string('actor_name', 100);
      t.timestamp('created_at').notNullable();
    });
  }
  if (await db.schema.hasTable('feature_flags'))
    await db('feature_flags')
      .insert({ key: 'albumProducts', value: false })
      .onConflict('key')
      .ignore();
  if (await db.schema.hasTable('permissions')) {
    for (const [name, label] of [
      ['products.view', 'View products'],
      ['products.manage', 'Manage product catalogue'],
      ['products.configure', 'Assign and confirm product choices'],
    ]) {
      await db('permissions')
        .insert({
          name,
          display_name: label,
          category: 'products',
          description: label,
        })
        .onConflict('name')
        .ignore();
      const permission = await db('permissions').where({ name }).first();
      for (const role of (await db.schema.hasTable('roles')) &&
      (await db.schema.hasTable('role_permissions'))
        ? await db('roles').whereIn('name', ['super_admin', 'admin'])
        : [])
        await db('role_permissions')
          .insert({ role_id: role.id, permission_id: permission.id })
          .onConflict(['role_id', 'permission_id'])
          .ignore();
    }
  }
};
exports.down = async function (db) {
  for (const table of [
    'album_product_choice_history',
    'event_album_products',
    'album_product_images',
    'album_product_catalogue',
  ])
    await db.schema.dropTableIfExists(table);
  if (await db.schema.hasTable('feature_flags'))
    await db('feature_flags').where({ key: 'albumProducts' }).del();
  if (await db.schema.hasTable('backup_paths'))
    await db('backup_paths').where({ path: 'album-products' }).del();
  // Keep granted permission definitions: a rolled-back feature has no routes.
};
