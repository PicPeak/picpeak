// Upgrade installations that already have a pending forced password reset.
const { formatBoolean } = require('../../src/utils/dbCompat');
exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('api_tokens'))
    || !(await knex.schema.hasTable('admin_users'))
    || !(await knex.schema.hasColumn('admin_users', 'must_change_password'))) return;
  await knex('api_tokens').whereNull('revoked_at').whereIn('created_by',
    knex('admin_users').select('id').where('must_change_password', formatBoolean(true))
  ).update({ revoked_at: knex.fn.now() });
};

// Revoked credentials must never become valid again on rollback.
exports.down = async function() {};
