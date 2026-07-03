/**
 * #322 — long-lived API tokens for programmatic access (n8n, custom
 * integrations, external apps). Each token belongs to an admin user; the
 * token's effective permissions are the *intersection* of the user's
 * role permissions and the token's own scope flags. That way revoking
 * the user revokes the token, and scope flags let an admin issue a
 * read-only token even if their account is super_admin.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('api_tokens'))) {
    await knex.schema.createTable('api_tokens', (table) => {
      table.increments('id').primary();
      table.string('name', 100).notNullable();
      // SHA-256 of the full token string (`pp_live_<random>`). Lookup
      // hashes the incoming Authorization header and queries by this.
      table.string('hashed_token', 64).notNullable().unique();
      // Scope flags — comma-separated subset of: read, write, admin.
      // 'read' allows GETs; 'write' adds POST/PATCH/DELETE on
      // event/photo data; 'admin' allows creating/deleting events and
      // anything else gated by admin.* permissions.
      table.string('scopes', 64).notNullable().defaultTo('read');
      table.integer('created_by').notNullable()
        .references('id').inTable('admin_users').onDelete('CASCADE');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('expires_at').nullable();
      table.timestamp('last_used_at').nullable();
      table.timestamp('revoked_at').nullable();
      // Cosmetic for the admin UI: first 8 chars of the plaintext
      // token (after the prefix) so admins can identify which token is
      // which without seeing the secret half.
      table.string('preview', 16).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('api_tokens')) {
    await knex.schema.dropTable('api_tokens');
  }
};
