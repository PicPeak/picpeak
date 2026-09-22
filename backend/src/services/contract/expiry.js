'use strict';

/**
 * The hourly sweep over contracts out for signature (#1446).
 *
 * - A contract whose time to sign has run out (signers.signingDeadline)
 *   becomes `expired`: every link and session is withdrawn, the log gets an
 *   `expired` event naming the signers who had already signed, the workflow
 *   engine hears `contract.expired`, and the admin gets one notice. A partly
 *   signed contract expires too — re-sending means a new contract, never
 *   this one coming back.
 * - Signers who haven't signed get reminders on the steps of
 *   `crm_contracts_reminder_days` (default "3,7", empty = off): each step is
 *   that many days after their last link, and goes out through the resend
 *   path with a new link (signingV2.sendReminder), in signing order.
 * - Codes and signing sessions that ended more than 30 days ago are removed.
 *
 * Several replicas run this at once. The flip is a conditional update on
 * `status`, and only the run that reports an updated row goes on to revoke,
 * append and notify — so each contract expires, and is announced, once.
 * Times are compared in JS (utils/queueTimestamps.toMillis).
 */

const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { scheduledTask } = require('../scheduledTask');
const { auditedUpdate } = require('../accountingHistory');
const signers = require('./signers');
const signingEvents = require('./signingEvents');
const { emitContractEvent } = require('./helpers');
const { getAppSetting } = require('../../utils/appSettings');
const { toMillis } = require('../../utils/queueTimestamps');

const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_AFTER_MS = 30 * DAY_MS;
// The statuses whose clock runs: out for signature, or collecting the
// customer's details first.
const RUNNING = ['sent', 'awaiting_data'];

const task = scheduledTask(() => runContractSigningSweep(), { schedule: '35 * * * *' });
const startContractSigningSweep = () => task.start();
const stopContractSigningSweep = () => task.stop();

/** Expire one contract. Resolves true only for the run that flipped it. */
async function expireContract(contract, now) {
  const stamp = new Date(now).toISOString();
  const signedSignerIds = await db.transaction(async (trx) => {
    const flipped = await auditedUpdate(trx, 'contracts', { id: contract.id, status: contract.status },
      { status: 'expired', updated_at: stamp }, { actor: { type: 'system' }, source: 'contract.expire' });
    if (!flipped) return null;
    await signers.revokeAccess(trx, contract.id);
    const signed = (await signers.listSigners(contract.id, trx))
      .filter((row) => row.role === 'customer' && row.status === 'signed')
      .map((row) => Number(row.id));
    await signingEvents.appendEvent(trx, contract.id, {
      type: 'expired', actorType: 'system', payload: { signedSignerIds: signed },
    });
    return signed;
  });
  if (!signedSignerIds) return false;

  // The expiry stands; what follows only announces it.
  try {
    const signingV2 = require('./signingV2');
    await emitContractEvent(contract, 'expired');
    await signingV2.notifyAdmin('contract_expired_admin_notification', {
      contract_number: contract.contract_number,
      signed_count: String(signedSignerIds.length),
      admin_dashboard_url: await signingV2.adminDashboardUrl(contract.id),
    });
    await logActivity('contract_expired', { contractId: contract.id, signedSignerIds }, null,
      { type: 'system', name: 'Contract expiry' });
  } catch (err) {
    logger.warn('A step after a contract expired failed', { contractId: contract.id, message: err.message });
  }
  return true;
}

async function expireDue(now) {
  const due = [];
  const running = await db('contracts').where({ signing_version: 2 }).whereIn('status', RUNNING);
  for (const contract of running) {
    const deadline = await signers.signingDeadline(contract);
    if (deadline != null && deadline <= now) due.push(contract);
  }
  let expired = 0;
  for (const contract of due) {
    try {
      if (await expireContract(contract, now)) expired += 1;
    } catch (err) {
      logger.error('Could not expire a contract', { contractId: contract.id, message: err.message });
    }
  }
  return expired;
}

/** The reminder steps in days, ascending: "3,7" → [3, 7]. Empty = none. */
async function reminderSteps() {
  const raw = await getAppSetting('crm_contracts_reminder_days', '3,7');
  const list = (Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(','))
    .map((part) => Number(String(part).trim()))
    .filter((days) => Number.isInteger(days) && days > 0 && days <= 365);
  return [...new Set(list)].sort((a, b) => a - b).slice(0, 10);
}

async function remindDue(now) {
  const steps = await reminderSteps();
  if (!steps.length) return 0;
  const signingV2 = require('./signingV2');
  let sent = 0;
  const running = await db('contracts').where({ signing_version: 2 }).whereIn('status', RUNNING);
  for (const contract of running) {
    const rows = await signers.listSigners(contract.id);
    // Only whoever may sign now: in a sequential contract, the next signer.
    for (const row of signingV2.dueSigners(contract, rows).filter((r) => r.status === 'invited')) {
      const count = Number(row.reminder_count) || 0;
      if (count >= steps.length) continue;
      const since = toMillis(row.invited_at);
      if (since == null || now - since < steps[count] * DAY_MS) continue;
      try {
        if ((await signingV2.sendReminder(contract.id, row.id, { expectedCount: count })).reminded) sent += 1;
      } catch (err) {
        await signingV2.recordFollowUpFailure(contract.id, 'reminder', err);
      }
    }
  }
  return sent;
}

async function runContractSigningSweep(now = Date.now()) {
  const { ensureContractEmailTemplatesSeeded } = require('../contractEmailTemplates');
  await ensureContractEmailTemplatesSeeded(db, logger);
  const expired = await expireDue(now);
  const reminded = await remindDue(now);
  const purged = await signers.purgeEndedAccess(PURGE_AFTER_MS, now);
  if (expired || reminded || purged.contract_signing_otps || purged.contract_signing_sessions) {
    logger.info('Contract signing sweep', {
      expired, reminded, purgedCodes: purged.contract_signing_otps, purgedSessions: purged.contract_signing_sessions,
    });
  }
  return { expired, reminded, purged };
}

module.exports = {
  PURGE_AFTER_MS,
  startContractSigningSweep,
  stopContractSigningSweep,
  runContractSigningSweep,
  expireContract,
  reminderSteps,
};
