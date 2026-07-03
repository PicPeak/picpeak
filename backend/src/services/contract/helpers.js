// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { nextDocumentNumber } = require('../../utils/documentSequences');


const SECTIONS_ORDER = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];

/**
 * Build a proper {id, type, name} actor object for logActivity. The
 * db.js helper silently downgrades string actors (e.g. 'admin:1') to
 * actor_type='system' with null name, so the audit timeline showed
 * "system" for every admin-driven event. Fetching the admin's name
 * once per service call is a small read cost on a non-hot path.
 *
 * Pass `customerPublic()` for events triggered by the public token
 * (customer signing, customer wet-signed PDF upload).
 */
async function adminActor(adminId) {
  if (!adminId) return { type: 'system' };
  try {
    // admin_users only carries username + email (no first/last/name
    // columns — confirmed from db.js:265). Prefer username for the
    // audit timeline because it's the operator-chosen identifier
    // shown elsewhere in the admin UI; fall back to email when an
    // older install seeded a row without a username.
    const row = await db('admin_users')
      .where({ id: adminId })
      .select('id', 'username', 'email')
      .first();
    if (!row) return { id: adminId, type: 'admin', name: `Admin #${adminId}` };
    const displayName = row.username || row.email || `Admin #${adminId}`;
    return { id: adminId, type: 'admin', name: displayName };
  } catch (_) {
    return { id: adminId, type: 'admin', name: `Admin #${adminId}` };
  }
}

function customerPublicActor() {
  return { type: 'customer', name: 'Customer (public link)' };
}

/**
 * Fire a contract lifecycle event for the workflow engine. Best-effort:
 * resolves the customer email (so send_email actions have a recipient) and
 * never throws into the caller. No-op when the workflows flag is off (emit
 * fails closed). Mirrors quoteService.emitQuoteEvent.
 */
async function emitContractEvent(contract, status) {
  try {
    let customerEmail = null;
    if (contract.customer_account_id) {
      const c = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
      customerEmail = c?.email || null;
    }
    await require('../workflows').emitWorkflowEvent(`contract.${status}`, {
      entityType: 'contract',
      entityId: contract.id,
      payload: {
        contractId: contract.id,
        contractNumber: contract.contract_number,
        customerAccountId: contract.customer_account_id || null,
        customerEmail,
        eventName: contract.event_name || null,
        title: contract.title || null,
      },
    });
  } catch (err) {
    logger.warn('Failed to emit contract workflow event', { contractId: contract.id, status, error: err.message });
  }
}

/**
 * Privacy gate for the customer/admin IP captured at signing time.
 * The `crm_contracts_store_ip` setting (default true) controls
 * whether the IP is persisted into the DB. When off, this helper
 * returns null regardless of what the route passed in — same shape
 * the rest of the code expects, just with no IP data.
 *
 * Default-true means upgrades preserve current behaviour. Operators
 * with strict data-minimisation requirements opt out in Settings →
 * CRM-Settings → Contracts.
 */
async function maybeStoreIp(ip) {
  if (!ip) return null;
  const enabled = await getAppSetting('crm_contracts_store_ip');
  // Default true: only block when EXPLICITLY opted out. The audit
  // flagged that `enabled === false` missed legacy installs where
  // app_settings stored the toggle as a string ('false', '0') — those
  // would slip through and the IP would still get persisted despite
  // the operator's intent. Cover string/number/bool variants
  // defensively. Anything else (null, undefined, true) preserves
  // the default-on behavior.
  if (enabled === false) return null;
  if (enabled === 0 || enabled === '0') return null;
  if (typeof enabled === 'string' && enabled.toLowerCase() === 'false') return null;
  return ip;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------


/**
 * Gap-free per-year contract number sequence. See
 * utils/documentSequences.js for the locking story; migration 132
 * created the underlying table. Atomic against concurrent admin
 * creates — the previous SELECT-MAX-then-INSERT raced and could
 * emit `C-2026-AB12C3` after 5 retries.
 */
async function nextContractNumber(trx) {
  return nextDocumentNumber('contract', 'crm_contracts_number_format', 'C-{YEAR}-{SEQ:04d}', trx);
}

function ensureCustomerActive(customer) {
  if (!customer) throw new AppError('Customer not found', 404);
  if (customer.is_active === false || customer.is_active === 0) {
    throw new AppError('Customer is deactivated', 409);
  }
}
module.exports = {
  SECTIONS_ORDER,
  adminActor,
  customerPublicActor,
  emitContractEvent,
  maybeStoreIp,
  nextContractNumber,
  ensureCustomerActive,
};
