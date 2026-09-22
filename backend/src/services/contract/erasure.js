'use strict';

/**
 * What erasing a customer does to their contracts (#1446).
 *
 * Until this module existed, `eraseCustomer` anonymised `customer_accounts`
 * and stopped there: a live signing link on an unsigned contract kept
 * working, and the signers' encrypted evidence and the customer's name and
 * address inside the frozen `rendered_content` stayed as they were, with no
 * written rule saying which of that was on purpose. The rule is:
 *
 *   - a contract that carries NO signature is REDACTED. Every outstanding
 *     invitation, signing session and action token stops working, the
 *     signers' encrypted columns are cleared, and the customer's name and
 *     address are taken out of the frozen snapshot. Nothing was concluded,
 *     so there is nothing to keep. A draft or sent one is also CANCELLED;
 *     one that already ended (declined, cancelled) keeps its status — the
 *     outcome is not the customer's data, only the details around it are.
 *
 *   - a contract that carries AT LEAST ONE signature is KEPT WHOLE. It is
 *     evidence of a concluded — or partly concluded — agreement and stays
 *     for the retention period; the same stance erasure already takes for
 *     contract-linked customer documents. Its live invitations and sessions
 *     are still revoked: erasure ends the customer's access to the portal,
 *     it does not erase the record.
 *
 * Two deliberate non-changes:
 *
 *   - `rendered_content_sha256` is NOT recomputed after a redaction. It is
 *     the hash a signer would have been bound to, and rewriting it would be
 *     rewriting evidence. Migration 228's `rendered_content_redacted_at`
 *     records that the text behind the hash was redacted on erasure, so a
 *     later integrity check reads the mismatch as that rather than as
 *     tampering.
 *   - the signing event log keeps the signer labels it already carries.
 *     Each event's hash covers the one before it, so editing a label would
 *     break the chain for every event after it. The names left there belong
 *     to a contract nobody signed and are listed in the retention documentation
 *     (https://docs.picpeak.app/features/crm/contracts#what-erasing-a-customer-keeps)
 *     rather than silently removed.
 */

const { auditedUpdate } = require('../accountingHistory');
const signers = require('./signers');
const signingEvents = require('./signingEvents');

/** Placeholder keys in `rendered_content` that hold the customer's own data. */
const PII_PLACEHOLDERS = ['customer_name', 'customer_address'];

const stamp = () => new Date().toISOString();

/** A contract is signed once anyone has signed it — a customer or the issuer. */
const SIGNED_STATUSES = ['signed_by_customer', 'signed_by_admin', 'fully_signed'];

/**
 * The frozen snapshot with the customer's own placeholder values blanked,
 * or null when there is nothing to redact (no snapshot, or already blank).
 */
function redactSnapshot(raw) {
  if (!raw) return null;
  let snapshot;
  try {
    snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.placeholders) return null;
  const present = PII_PLACEHOLDERS.filter((key) => snapshot.placeholders[key]);
  if (!present.length) return null;
  const placeholders = { ...snapshot.placeholders };
  for (const key of present) placeholders[key] = '';
  return JSON.stringify({ ...snapshot, placeholders });
}

/**
 * Read what erasing this customer would do to their contracts, on the global
 * connection. Split from apply() so that neither the table checks nor the
 * reads happen inside the caller's transaction: schema introspection on the
 * global connection inside a transaction deadlocks SQLite's single
 * connection (CLAUDE.md).
 *
 * Returns null when contracts aren't on this install.
 */
async function plan(db, customerId) {
  if (!(await db.schema.hasTable('contracts'))) return null;
  const hasSigners = await db.schema.hasTable('contract_signers');
  const hasRedactedColumn = await db.schema.hasColumn('contracts', 'rendered_content_redacted_at');
  const rows = await db('contracts').where({ customer_account_id: customerId })
    .select('id', 'status', 'rendered_content', 'signed_by_customer_at', 'signed_by_admin_at', 'signed_pdf_path');
  if (!rows.length) return { redact: [], retain: [], hasSigners, hasRedactedColumn };

  const signedIds = hasSigners
    ? new Set((await db('contract_signers')
      .whereIn('contract_id', rows.map((r) => r.id))
      .where({ status: 'signed' })
      .distinct('contract_id')).map((r) => Number(r.contract_id)))
    : new Set();

  const redact = [];
  const retain = [];
  for (const row of rows) {
    const signed = signedIds.has(Number(row.id))
      || SIGNED_STATUSES.includes(row.status)
      || !!row.signed_by_customer_at || !!row.signed_by_admin_at || !!row.signed_pdf_path;
    if (signed) {
      retain.push(row.id);
    } else {
      redact.push({
        id: row.id,
        status: row.status,
        cancel: ['draft', 'sent', 'awaiting_data'].includes(row.status),
        redacted: redactSnapshot(row.rendered_content),
      });
    }
  }
  return { redact, retain, hasSigners, hasRedactedColumn };
}

/** Revoke every way into a contract: signer links and sessions, action tokens. */
async function revokeAllAccess(trx, contractId, hasSigners) {
  if (hasSigners) await signers.revokeAccess(trx, contractId);
  await trx('contract_action_tokens').where({ contract_id: contractId }).whereNull('used_at')
    .update({ expires_at: stamp() });
}

/**
 * Apply a plan() inside the erasure's own transaction.
 *
 * Each redaction is claimed with a conditional update on the status that
 * plan() read, so a signature landing in between leaves the contract alone
 * rather than redacting (or cancelling) a contract that has since been
 * signed. Only a draft or sent contract changes status; one that already
 * ended keeps the one it has.
 */
async function apply(trx, contractPlan, actor) {
  if (!contractPlan) return { cancelled: [], redacted: [], retained: [] };
  const history = { actor, source: 'customer.erase' };
  const cancelled = [];
  const redacted = [];

  for (const entry of contractPlan.redact) {
    const claim = (q) => q.where({ id: entry.id, status: entry.status });
    const applied = await auditedUpdate(trx, 'contracts', claim, {
      ...(entry.cancel ? { status: 'cancelled' } : {}),
      ...(entry.redacted ? { rendered_content: entry.redacted } : {}),
      ...(entry.redacted && contractPlan.hasRedactedColumn ? { rendered_content_redacted_at: stamp() } : {}),
      updated_at: stamp(),
    }, history);
    if (!applied) continue;
    await revokeAllAccess(trx, entry.id, contractPlan.hasSigners);
    if (contractPlan.hasSigners) {
      // The evidence columns of a contract nobody signed. email_hash goes
      // with them: it is a lookup key for an address that no longer exists,
      // and a hashed email is still the customer's.
      await trx('contract_signers').where({ contract_id: entry.id }).update({
        name_enc: null,
        email_enc: null,
        email_hash: null,
        ip_enc: null,
        user_agent_enc: null,
        decline_reason_enc: null,
        updated_at: stamp(),
      });
      await signingEvents.appendEvent(trx, entry.id, {
        type: 'revoked',
        actorType: 'admin',
        actorLabel: (actor && actor.name) || null,
        payload: { reason: 'customer_erased' },
      });
    }
    (entry.cancel ? cancelled : redacted).push(entry.id);
  }

  for (const id of contractPlan.retain) {
    await revokeAllAccess(trx, id, contractPlan.hasSigners);
  }
  return { cancelled, redacted, retained: contractPlan.retain };
}

module.exports = {
  PII_PLACEHOLDERS,
  plan,
  apply,
  _internal: { redactSnapshot },
};
