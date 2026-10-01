/**
 * transferCleanupService — retention lifecycle for PicTransfer (#997).
 *
 * Runs hourly (offset from the gallery expiration checker so the two don't
 * collide) and drives three transitions:
 *
 *   1. Expire    — an active transfer past `expires_at` is disabled
 *                  (is_active=false, disabled_at=now). This is the "disable the
 *                  link after the set time period" behaviour. A transfer
 *                  disabled early by its download cap is already in this state.
 *   2. Notify    — the admin is emailed once when a transfer becomes inactive
 *                  (admin_notified_at stamped so it never repeats).
 *   3. Delete    — `grace_days` after disable, the client-uploaded files are
 *                  removed and the transfer record is dropped. (The gallery
 *                  originals a transfer pointed at are owned by their events and
 *                  are never touched — only the transfer's own ad-hoc uploads
 *                  are deleted, which is what the retention cap is about.)
 */

const { scheduledTask } = require('./scheduledTask');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');
const { sendTemplateEmail } = require('./emailProcessor');
const transferService = require('./transferService');

const DAY_MS = 24 * 60 * 60 * 1000;

const task = scheduledTask(runTransferCleanup, { schedule: '15 * * * *' });
function startTransferCleanup() { task.start(); }
const stopTransferCleanup = () => task.stop();

async function runTransferCleanup() {
  try {
    await expireTransfers();
    await notifyExpiredTransfers();
    await deleteRetiredTransfers();
  } catch (err) {
    logger.error('Transfer cleanup error', { error: err.message });
  }
}

/** Disable links whose time window has passed. */
async function expireTransfers() {
  const now = new Date();
  const due = await db('transfers')
    .where('is_active', formatBoolean(true))
    .whereNull('deleted_at')
    .whereNotNull('expires_at')
    .where('expires_at', '<=', now);

  for (const t of due) {
    await db('transfers').where({ id: t.id }).update({
      is_active: formatBoolean(false),
      disabled_at: t.disabled_at || now,
      updated_at: now,
    });
    logger.info(`Transfer ${t.id} expired`);
  }
}

/** Email the admin(s) once per transfer that has become inactive. */
async function notifyExpiredTransfers() {
  const pending = await db('transfers')
    .where('is_active', formatBoolean(false))
    .whereNull('deleted_at')
    .whereNull('admin_notified_at')
    .whereNotNull('disabled_at');

  if (!pending.length) return;

  // Scoped the same way the files-received notice is: a transfer belongs to
  // the admin who created it, and the ownership guard 404s everyone else from
  // it, so telling every admin its title is a wider audience than the row
  // itself has. The fan-out remains only for a legacy row with no creator.
  const allAdmins = await db('admin_users')
    .where('is_active', formatBoolean(true))
    .whereNotNull('email')
    .select('id', 'email');
  const adminsById = new Map(allAdmins.map((a) => [a.id, a]));
  const recipientsFor = (transfer) => {
    if (!transfer.created_by) return allAdmins;
    const owner = adminsById.get(transfer.created_by);
    return owner ? [owner] : [];
  };
  // getFrontendUrl is async — without the await this interpolated the Promise
  // itself, so every expiry notice carried an "[object Promise]/admin/transfers"
  // link.
  const adminUrl = `${await transferService.getFrontendUrl()}/admin/transfers`;

  for (const t of pending) {
    const fileCount = await db('transfer_files').where('transfer_id', t.id).count('* as c').first();
    const uploadCount = await db('transfer_uploads').where('transfer_id', t.id).count('* as c').first();
    const grace = Number(t.grace_days) || 0;
    const deleteDate = new Date(new Date(t.disabled_at).getTime() + grace * DAY_MS);

    const vars = {
      transfer_title: t.title || `Transfer #${t.id}`,
      expiry_date: new Date(t.disabled_at).toISOString().slice(0, 10),
      file_count: String(Number(fileCount?.c) || 0),
      upload_count: String(Number(uploadCount?.c) || 0),
      grace_days: String(grace),
      delete_date: deleteDate.toISOString().slice(0, 10),
      admin_url: adminUrl,
    };

    let sent = false;
    const recipients = recipientsFor(t);
    // No reachable owner: stamp so the sweep moves on rather than retrying
    // this row every hour forever.
    for (const { email } of recipients) {
      try {
        await sendTemplateEmail(email, 'transfer_link_expired', vars);
        sent = true;
      } catch (err) {
        // Email not configured / SMTP down — don't spin forever retrying; just
        // stamp so the sweep moves on. The transfer still expires + deletes.
        logger.warn('Failed to send transfer_link_expired notification', {
          transferId: t.id, email, error: err.message,
        });
      }
    }

    // Stamp regardless so we notify at most once even if delivery failed
    // (avoids an unbounded retry loop every hour).
    await db('transfers').where({ id: t.id }).update({ admin_notified_at: new Date() });
    if (sent) logger.info(`Notified admins that transfer ${t.id} expired`);
  }
}

/** Hard-delete transfers whose retention window has fully elapsed. */
async function deleteRetiredTransfers() {
  const candidates = await db('transfers')
    .where('is_active', formatBoolean(false))
    .whereNull('deleted_at')
    .whereNotNull('disabled_at');

  const now = Date.now();
  for (const t of candidates) {
    const grace = Number(t.grace_days) || 0;
    const deleteAt = new Date(t.disabled_at).getTime() + grace * DAY_MS;
    if (deleteAt > now) continue;
    try {
      await transferService.deleteTransfer(t.id);
      logger.info(`Transfer ${t.id} deleted after ${grace}-day retention`);
    } catch (err) {
      logger.error('Failed to delete retired transfer', { transferId: t.id, error: err.message });
    }
  }
}

module.exports = {
  stopTransferCleanup,
  startTransferCleanup,
  // exported for tests / manual invocation
  runTransferCleanup,
  expireTransfers,
  notifyExpiredTransfers,
  deleteRetiredTransfers,
};
