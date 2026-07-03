const { db } = require('../../src/database/db');

async function up() {
  // Check if host_name column already exists
  const hasHostName = await db.schema.hasColumn('events', 'host_name');
  
  if (!hasHostName) {
    await db.schema.table('events', (table) => {
      table.string('host_name').after('event_date');
    });
    
    console.log('Added host_name column to events table');
  }
}

async function down() {
  await db.schema.table('events', (table) => {
    table.dropColumn('host_name');
  });
}

module.exports = { up, down };

// Run migration if called directly
if (require.main === module) {
  up()
    .then(() => {
      console.log('Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}