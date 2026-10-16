/**
 * Gallery passwords and client PINs no longer sit in clear text in the mail
 * and WhatsApp queues. A sent gallery_created mail kept them in email_data
 * (rows sent before the archive scrub, and every row still waiting or
 * failed), and whatsapp_queue kept them for good.
 *
 * Rows that can still be sent keep the value sealed with the email-queue key
 * (EMAIL_QUEUE_ENCRYPTION_KEY, else JWT_SECRET), so they still deliver the
 * real password; final rows keep only the archive mask. The same pass runs
 * after a portable import.
 *
 * down() is intentionally empty: a masked password cannot be restored, and
 * rolling back leaves sealed values sealed.
 */
const { protectQueuedPasswords } = require('../../src/services/accountRecoveryStorageHardening');

exports.up = async function up(knex) {
  await protectQueuedPasswords(knex);
};

exports.down = async function down() {};
