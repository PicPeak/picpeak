const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { deleteAllForAdmin } = require('./passkeyService');

// Shared by interactive and command-line recovery. Keep the reset and key
// revocation in one transaction so a failed write cannot leave old keys live.
// The account's passkeys go with it: a reset means the account may be
// compromised or its owner gone, and a passkey signs in without the password.
// Resolves to the number of passkeys removed.
async function setAdminPasswordForReset(adminId, passwordHash) {
  return db.transaction(async (trx) => {
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
    return deleteAllForAdmin(adminId, trx);
  });
}

module.exports = { setAdminPasswordForReset };
