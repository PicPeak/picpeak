exports.up = async function(knex) {
  // Check if tables already exist to avoid conflicts
  const hasRevokedTokensTable = await knex.schema.hasTable('revoked_tokens');
  const hasUserTokenRevocationsTable = await knex.schema.hasTable('user_token_revocations');
  
  // Create revoked_tokens table if it doesn't exist
  if (!hasRevokedTokensTable) {
    await knex.schema.createTable('revoked_tokens', table => {
      table.increments('id').primary();
      table.string('token_id').notNullable().unique(); // JWT ID or generated ID
      table.integer('user_id').nullable(); // User who owned the token
      table.string('token_type', 20); // admin, gallery, etc.
      table.timestamp('revoked_at').defaultTo(knex.fn.now());
      table.timestamp('expires_at').notNullable(); // When token would have expired
      table.string('reason', 100); // password_change, logout, compromised, etc.
      table.text('metadata'); // Additional JSON data
      
      // Indexes for performance
      table.index('token_id');
      table.index('user_id');
      table.index('expires_at'); // For cleanup
    });
  }
  
  // Create user_token_revocations table if it doesn't exist
  if (!hasUserTokenRevocationsTable) {
    await knex.schema.createTable('user_token_revocations', table => {
      table.integer('user_id').primary();
      table.timestamp('revoked_at').notNullable();
      table.string('reason', 100);
      
      // Index for quick lookups
      table.index('revoked_at');
    });
  }
  
  // Add any missing indexes if tables already existed
  if (hasRevokedTokensTable) {
    try {
      // Try to add indexes if they don't exist (PostgreSQL syntax)
      await knex.raw('CREATE INDEX IF NOT EXISTS "revoked_tokens_token_id_index" ON "revoked_tokens" ("token_id")');
      await knex.raw('CREATE INDEX IF NOT EXISTS "revoked_tokens_user_id_index" ON "revoked_tokens" ("user_id")');
      await knex.raw('CREATE INDEX IF NOT EXISTS "revoked_tokens_expires_at_index" ON "revoked_tokens" ("expires_at")');
    } catch (error) {
      // For SQLite compatibility, ignore errors if indexes already exist
      console.log('Note: Some indexes may already exist, continuing...');
    }
  }
  
  if (hasUserTokenRevocationsTable) {
    try {
      await knex.raw('CREATE INDEX IF NOT EXISTS "user_token_revocations_revoked_at_index" ON "user_token_revocations" ("revoked_at")');
    } catch (error) {
      console.log('Note: Some indexes may already exist, continuing...');
    }
  }
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('user_token_revocations')
    .dropTableIfExists('revoked_tokens');
};