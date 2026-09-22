const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');

// Shared by interactive and command-line recovery. Keep the reset and key
// revocation in one transaction so a failed write cannot leave old keys live.
async function setAdminPasswordForReset(adminId, passwordHash) {
  await db.transaction(async (trx) => {
    await trx('admin_users').where({ id: adminId }).update({
      password_hash: passwordHash,
      must_change_password: formatBoolean(true),
      password_changed_at: new Date(),
      updated_at: new Date()
    });
    if (await trx.schema.hasTable('api_tokens')) {
      await trx('api_tokens').where({ created_by: adminId }).whereNull('revoked_at')
        .update({ revoked_at: new Date().toISOString() });
    }
  });
}

module.exports = { setAdminPasswordForReset };
