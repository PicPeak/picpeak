/**
 * Migration helper functions for production-safe migrations
 */

/**
 * Create a table only if it doesn't already exist
 */
async function createTableIfNotExists(knex, tableName, callback) {
  const exists = await knex.schema.hasTable(tableName);
  if (!exists) {
    console.log(`Creating table: ${tableName}`);
    return knex.schema.createTable(tableName, callback);
  } else {
    console.log(`Table ${tableName} already exists, skipping...`);
  }
}

/**
 * Add column to table only if it doesn't exist
 */
async function addColumnIfNotExists(knex, tableName, columnName, callback) {
  const hasColumn = await knex.schema.hasColumn(tableName, columnName);
  if (!hasColumn) {
    console.log(`Adding column ${columnName} to table ${tableName}`);
    return knex.schema.alterTable(tableName, (table) => {
      callback(table);
    });
  } else {
    console.log(`Column ${columnName} already exists in table ${tableName}, skipping...`);
  }
}

/**
 * Insert data only if it doesn't already exist
 */
async function insertIfNotExists(knex, tableName, data, uniqueField) {
  const exists = await knex(tableName)
    .where(uniqueField, data[uniqueField])
    .first();
  
  if (!exists) {
    console.log(`Inserting ${uniqueField}: ${data[uniqueField]} into ${tableName}`);
    return knex(tableName).insert(data);
  } else {
    console.log(`${uniqueField}: ${data[uniqueField]} already exists in ${tableName}, skipping...`);
  }
}

/**
 * Create index only if it doesn't exist
 */
async function createIndexIfNotExists(knex, tableName, columns, indexName) {
  // This is database-specific, works for PostgreSQL
  if (knex.client.config.client === 'pg') {
    const result = await knex.raw(`
      SELECT 1 FROM pg_indexes 
      WHERE tablename = ? AND indexname = ?
    `, [tableName, indexName]);
    
    if (result.rows.length === 0) {
      console.log(`Creating index ${indexName} on ${tableName}`);
      return knex.schema.alterTable(tableName, (table) => {
        table.index(columns, indexName);
      });
    }
  } else {
    // For SQLite, just try to create and ignore errors
    try {
      await knex.schema.alterTable(tableName, (table) => {
        table.index(columns, indexName);
      });
    } catch (error) {
      // Index probably already exists
    }
  }
}

module.exports = {
  createTableIfNotExists,
  addColumnIfNotExists,
  insertIfNotExists,
  createIndexIfNotExists
};