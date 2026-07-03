exports.up = async function(knex) {
  // Check if columns already exist to avoid conflicts
  const hasPasswordChangedAt = await knex.schema.hasColumn('admin_users', 'password_changed_at');
  const hasLastLoginIp = await knex.schema.hasColumn('admin_users', 'last_login_ip');
  const hasTwoFactorEnabled = await knex.schema.hasColumn('admin_users', 'two_factor_enabled');
  const hasTwoFactorSecret = await knex.schema.hasColumn('admin_users', 'two_factor_secret');
  
  return knex.schema.table('admin_users', table => {
    // Add password change tracking
    if (!hasPasswordChangedAt) {
      table.timestamp('password_changed_at').nullable();
    }
    
    // Add last login IP for security monitoring  
    if (!hasLastLoginIp) {
      table.string('last_login_ip', 45).nullable();
    }
    
    // Add account security flags
    if (!hasTwoFactorEnabled) {
      table.boolean('two_factor_enabled').defaultTo(false);
    }
    if (!hasTwoFactorSecret) {
      table.string('two_factor_secret').nullable();
    }
  });
};

exports.down = function(knex) {
  return knex.schema.table('admin_users', table => {
    table.dropColumn('password_changed_at');
    table.dropColumn('last_login_ip');
    table.dropColumn('two_factor_enabled');
    table.dropColumn('two_factor_secret');
  });
};