/**
 * Migration: Add event_types table
 *
 * Creates a customizable event types system to replace hardcoded event types.
 * This allows users to:
 * - Rename existing event types (wedding, birthday, corporate, other)
 * - Create custom event types with custom slug prefixes
 * - Associate default theme presets with event types
 *
 * Backward compatible: Existing events keep their event_type strings.
 * New events can use either legacy strings or custom event type slug_prefix.
 */

const { createTableIfNotExists, insertIfNotExists } = require('../helpers');

exports.up = async function(knex) {
  console.log('Creating event_types table...');

  // Create event_types table
  const hasEventTypesTable = await knex.schema.hasTable('event_types');
  if (!hasEventTypesTable) {
    await knex.schema.createTable('event_types', (table) => {
      table.increments('id').primary();
      table.string('name', 100).notNullable(); // Display name: "Family Shoot"
      table.string('slug_prefix', 50).unique().notNullable(); // URL prefix: "family"
      table.string('emoji', 10); // Icon emoji: "👨‍👩‍👧"
      table.string('theme_preset', 50); // Default theme: "elegantWedding"
      table.text('theme_config'); // Custom theme JSON overrides (optional)
      table.integer('display_order').defaultTo(0); // Sorting in dropdowns
      table.boolean('is_system').defaultTo(false); // Protect default types
      table.boolean('is_active').defaultTo(true); // Allow hiding types
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      // Indexes for performance
      table.index('slug_prefix');
      table.index('display_order');
      table.index('is_active');
    });
    console.log('event_types table created');
  } else {
    console.log('event_types table already exists, skipping creation');
  }

  // Seed default event types (matching current hardcoded values)
  const existingTypes = await knex('event_types').select('slug_prefix');
  const existingSlugs = existingTypes.map(t => t.slug_prefix);

  const defaultTypes = [
    {
      name: 'Wedding',
      slug_prefix: 'wedding',
      emoji: '💒',
      theme_preset: 'elegantWedding',
      display_order: 1,
      is_system: true,
      is_active: true
    },
    {
      name: 'Birthday',
      slug_prefix: 'birthday',
      emoji: '🎂',
      theme_preset: 'birthdayFun',
      display_order: 2,
      is_system: true,
      is_active: true
    },
    {
      name: 'Corporate',
      slug_prefix: 'corporate',
      emoji: '🏢',
      theme_preset: 'corporateTimeline',
      display_order: 3,
      is_system: true,
      is_active: true
    },
    {
      name: 'Other',
      slug_prefix: 'other',
      emoji: '📸',
      theme_preset: 'default',
      display_order: 4,
      is_system: true,
      is_active: true
    }
  ];

  const typesToInsert = defaultTypes.filter(type => !existingSlugs.includes(type.slug_prefix));

  if (typesToInsert.length > 0) {
    await knex('event_types').insert(typesToInsert);
    console.log(`Inserted ${typesToInsert.length} default event types`);
  } else {
    console.log('Default event types already exist, skipping seed');
  }

  console.log('Migration 061_add_event_types_table completed successfully');
};

exports.down = async function(knex) {
  console.log('Rolling back event_types table...');

  // Drop the table (data will be lost)
  await knex.schema.dropTableIfExists('event_types');

  console.log('event_types table dropped');
};
