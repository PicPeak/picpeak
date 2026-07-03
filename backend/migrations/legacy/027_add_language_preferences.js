exports.up = async function(knex) {
  // Add language column to events table if it doesn't exist
  const hasLanguageInEvents = await knex.schema.hasColumn('events', 'language');
  if (!hasLanguageInEvents) {
    await knex.schema.alterTable('events', function(table) {
      table.string('language', 5).defaultTo('en');
    });
  }
  
  // Add default_language to email_configs if it doesn't exist
  const hasDefaultLanguage = await knex.schema.hasColumn('email_configs', 'default_language');
  if (!hasDefaultLanguage) {
    await knex.schema.alterTable('email_configs', function(table) {
      table.string('default_language', 5).defaultTo('en');
    });
  }
  
  // Set default language to German for the existing email config
  await knex('email_configs')
    .update({
      default_language: 'de'
    });
};

exports.down = async function(knex) {
  // Remove language column from events table
  const hasLanguageInEvents = await knex.schema.hasColumn('events', 'language');
  if (hasLanguageInEvents) {
    await knex.schema.alterTable('events', function(table) {
      table.dropColumn('language');
    });
  }
  
  // Remove default_language from email_configs
  const hasDefaultLanguage = await knex.schema.hasColumn('email_configs', 'default_language');
  if (hasDefaultLanguage) {
    await knex.schema.alterTable('email_configs', function(table) {
      table.dropColumn('default_language');
    });
  }
};