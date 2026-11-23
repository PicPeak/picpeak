'use strict';

/**
 * Invitation and password-reset links of customer logins, shared by the
 * account holder (customerAccountsService) and further contacts
 * (customerContactsService).
 */

const { ValidationError } = require('../utils/errors');

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches admin invites
const PASSWORD_RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Claim an invitation / reset link before acting on it. Two submissions of
// the same link both pass the reads before either commits; only the one
// whose conditional update affects the row may go on to set credentials, so
// a later submission cannot overwrite what the first one set. A concurrent
// cancellation (which deletes the row) also lands here as zero rows.
async function claimInvitation(trx, id) {
  const claimed = await trx('customer_invitations')
    .where('id', id).whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .update({ accepted_at: new Date().toISOString() });
  if (claimed !== 1) throw new ValidationError('Invalid or expired invitation');
}

async function claimReset(trx, id) {
  const claimed = await trx('customer_password_resets')
    .where('id', id).whereNull('used_at').where('expires_at', '>', new Date())
    .update({ used_at: new Date().toISOString() });
  if (claimed !== 1) throw new ValidationError('Invalid or expired reset link');
}

module.exports = { INVITATION_TTL_MS, PASSWORD_RESET_TTL_MS, claimInvitation, claimReset };
