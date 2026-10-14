'use strict';

/**
 * Per-customer "no administrative emails" (migration 300).
 *
 * Some customers only want the amount and will transfer the money; they do
 * not want quote, contract or invoice mail. For those customers the CRM still
 * issues every document as usual (numbered, stored, in the tax report, and in
 * the customer portal when they have access) — only the mail to the customer
 * is held back. A passive customer (no portal login) gets nothing digitally;
 * the admin hands the documents over, and a contract is signed on paper and
 * uploaded.
 *
 * One decision per document. Every producer of these mails passes the
 * document's customer (queueEmail's `customerAccountId`): the mail is held
 * back when THAT customer opted out and the recipient is one of their own
 * addresses (login or billing email). So the mail, the Issue button, the
 * late fee and the signing chain all follow the same customer flag, and
 * other people stay unaffected: a co-signer at another address, the
 * business's own notices, another customer sharing a billing inbox.
 *
 * The decision is taken when the mail is queued. Resend / retry / send-now
 * of a held-back row ask again (projectService, System Health). Not covered:
 * the workflow `send_email` action, whose type is whatever the flow names.
 */

const { db } = require('../database/db');
const { hasColumnCached } = require('../utils/schemaCache');

// Customer-facing CRM mail. Deliberately NOT listed: account mail
// (invitation, password reset), contract_signing_code (a one-time code the
// customer asked for while signing in the portal), gallery and transfer mail,
// and every *_admin notification addressed to the business.
const ADMINISTRATIVE_EMAIL_TYPES = new Set([
  'quote_sent',
  'quote_accepted_customer',
  'quote_addons_updated',
  'invoice_sent',
  'invoice_reminder_first',
  'invoice_reminder_second',
  'invoice_paid_receipt',
  'storno_issued',
  'contract_sent',
  'contract_signature_reminder',
  'contract_signature_received',
  'contract_fully_signed',
  'contract_data_request',
  'customer_document_shared',
  'customer_document_reviewed',
  'customer_document_requested',
  'customer_document_request_reminder',
]);

function isAdministrativeEmailType(emailType) {
  return ADMINISTRATIVE_EMAIL_TYPES.has(emailType);
}

const asFlag = (value) => value === true || value === 1;
const norm = (value) => String(value || '').trim().toLowerCase();

/** The customer row the decisions need, or null (unknown id, pre-migration DB). */
async function loadCustomer(customerOrId) {
  if (customerOrId == null) return null;
  if (typeof customerOrId === 'object') {
    if ('no_admin_emails' in customerOrId) return customerOrId;
    customerOrId = customerOrId.id;
  }
  if (!(await hasColumnCached('customer_accounts', 'no_admin_emails'))) return null;
  return db('customer_accounts').where({ id: customerOrId })
    .first('id', 'email', 'billing_email', 'no_admin_emails');
}

/** Whether this customer opted out of administrative mail. */
async function customerTakesNoAdminEmails(customerOrId) {
  const customer = await loadCustomer(customerOrId);
  return !!customer && asFlag(customer.no_admin_emails);
}

/**
 * Whether a mail to `address` about this customer's documents is held back:
 * the customer opted out and the address is theirs (login or billing email).
 * Used for the queue gate and for every signer-level decision (first
 * invitation, resend, reminder sweep, the signer card).
 */
async function isHeldBackFor(customerOrId, address) {
  const customer = await loadCustomer(customerOrId);
  if (!customer || !asFlag(customer.no_admin_emails)) return false;
  const to = norm(address);
  return !!to && (to === norm(customer.email) || to === norm(customer.billing_email));
}

/**
 * The queue gate. With the document's customer (`customerAccountId`) this is
 * isHeldBackFor. Without one — a producer that predates this switch — the
 * address alone decides, and only when EVERY account at it opted out, so one
 * customer's switch never silences another's mail.
 */
async function isSuppressedForRecipient(recipientEmail, emailType, customerAccountId = null) {
  if (!isAdministrativeEmailType(emailType)) return false;
  if (customerAccountId != null) return isHeldBackFor(customerAccountId, recipientEmail);
  const address = norm(recipientEmail);
  if (!address) return false;
  if (!(await hasColumnCached('customer_accounts', 'no_admin_emails'))) return false;
  const matches = await db('customer_accounts')
    .where((q) => {
      q.whereRaw('LOWER(email) = ?', [address]).orWhereRaw('LOWER(billing_email) = ?', [address]);
    })
    .select('no_admin_emails');
  return matches.length > 0 && matches.every((row) => asFlag(row.no_admin_emails));
}

/**
 * For a queued row being sent again (resend / retry / send-now / System
 * Health retry): asks the switch as it is now, for the customer the row was
 * queued for (`__customerAccountId` in its data, see queueEmail).
 */
async function isRowHeldBack(row) {
  let data = row && row.email_data;
  try { data = typeof data === 'string' ? JSON.parse(data || '{}') : (data || {}); } catch (_) { data = {}; }
  const customerAccountId = data && data.__customerAccountId != null ? data.__customerAccountId : null;
  return isSuppressedForRecipient(row.recipient_email, row.email_type, customerAccountId);
}

module.exports = {
  isRowHeldBack,
  ADMINISTRATIVE_EMAIL_TYPES,
  isAdministrativeEmailType,
  isSuppressedForRecipient,
  isHeldBackFor,
  customerTakesNoAdminEmails,
};
