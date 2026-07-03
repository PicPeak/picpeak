const { db } = require('../../src/database/db');

async function up() {
  console.log('Adding photo categories and CMS tables...');
  
  // Check if tables already exist
  const hasPhotoCategoriesTable = await db.schema.hasTable('photo_categories');
  const hasCmsPagesTable = await db.schema.hasTable('cms_pages');
  const hasCategoryIdColumn = await db.schema.hasColumn('photos', 'category_id');
  const hasLanguageColumn = await db.schema.hasColumn('admin_users', 'language');
  
  // Create photo_categories table
  if (!hasPhotoCategoriesTable) {
    await db.schema.createTable('photo_categories', (table) => {
      table.increments('id').primary();
      table.string('name', 100).notNullable();
      table.string('slug', 100).notNullable();
      table.boolean('is_global').defaultTo(true);
      table.integer('event_id').references('id').inTable('events').onDelete('CASCADE');
      table.timestamp('created_at').defaultTo(db.fn.now());
      
      // Unique constraint for slug within event scope
      table.unique(['slug', 'event_id']);
    });
  }

  // Create cms_pages table
  if (!hasCmsPagesTable) {
    await db.schema.createTable('cms_pages', (table) => {
      table.increments('id').primary();
      table.string('slug', 100).unique().notNullable();
      table.text('title_en');
      table.text('title_de');
      table.text('content_en');
      table.text('content_de');
      table.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  // Add category_id to photos table
  if (!hasCategoryIdColumn) {
    await db.schema.alterTable('photos', (table) => {
      table.integer('category_id').references('id').inTable('photo_categories');
    });
  }

  // Add language preference to admin_users
  if (!hasLanguageColumn) {
    await db.schema.alterTable('admin_users', (table) => {
      table.string('language', 2).defaultTo('en');
    });
  }

  // Add language preference to app_settings for global default
  const hasDefaultLanguageSetting = await db('app_settings')
    .where('setting_key', 'default_language')
    .first();
    
  if (!hasDefaultLanguageSetting) {
    await db('app_settings').insert({
      setting_key: 'default_language',
      setting_value: JSON.stringify('en'),
      setting_type: 'general',
      updated_at: new Date()
    });
  }

  // Insert default global categories
  if (!hasPhotoCategoriesTable) {
    const defaultCategories = [
      { name: 'Ceremony', slug: 'ceremony', is_global: true },
      { name: 'Reception', slug: 'reception', is_global: true },
      { name: 'Portraits', slug: 'portraits', is_global: true },
      { name: 'Group Photos', slug: 'group-photos', is_global: true },
      { name: 'Details', slug: 'details', is_global: true },
      { name: 'Party', slug: 'party', is_global: true }
    ];

    await db('photo_categories').insert(defaultCategories);
  }

  // Insert default legal pages
  if (!hasCmsPagesTable) {
    await db('cms_pages').insert([
      {
        slug: 'impressum',
        title_en: 'Legal Notice',
        title_de: 'Impressum',
        content_en: '<h2>Legal Notice</h2><p>Please edit this content in the admin panel.</p>',
        content_de: '<h2>Impressum</h2><p>Bitte bearbeiten Sie diesen Inhalt im Admin-Panel.</p>',
        updated_at: new Date()
      },
      {
        slug: 'datenschutz',
        title_en: 'Privacy Policy',
        title_de: 'Datenschutzerklärung',
        content_en: '<h2>Privacy Policy</h2><p>Please edit this content in the admin panel.</p>',
        content_de: '<h2>Datenschutzerklärung</h2><p>Bitte bearbeiten Sie diesen Inhalt im Admin-Panel.</p>',
        updated_at: new Date()
      }
    ]);
  }

  console.log('Photo categories and CMS tables created successfully');
}

async function down() {
  // Remove language from app_settings
  await db('app_settings').where('setting_key', 'default_language').delete();
  
  // Drop columns
  await db.schema.alterTable('admin_users', (table) => {
    table.dropColumn('language');
  });
  
  await db.schema.alterTable('photos', (table) => {
    table.dropColumn('category_id');
  });
  
  // Drop tables
  await db.schema.dropTableIfExists('cms_pages');
  await db.schema.dropTableIfExists('photo_categories');
}

module.exports = { up, down };