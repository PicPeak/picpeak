/**
 * customerDocumentNotifications — the mails around customer documents
 * (#1444, plan slice 3).
 *
 *   customer_document_shared           → the customer, when the studio shares
 *                                        a document with them
 *   customer_document_uploaded_admin   → the business address, when a customer
 *                                        uploads one
 *   customer_document_reviewed         → the customer, when their upload is
 *                                        rejected (an accepted upload needs no
 *                                        mail)
 *   customer_document_requested /      → the customer, when the studio asks
 *   customer_document_request_reminder   for a document, and on each step of
 *                                        the reminder ladder
 *
 * Every mail is queued AFTER the write it reports has committed, and a
 * failure to queue never undoes that write: the caller gets 'failed' back
 * and says so, so the UI never claims a mail went out that didn't.
 *
 * Links lead to the portal login and on to the document
 * (/customer/documents/<id>); they carry no token. Log lines carry ids only —
 * no file names, no addresses.
 *
 * One mail per share. The plan's 10-minute digest (append to a not-yet-sent
 * queue row) does not fit the queue: the processor sends a pending row within
 * a minute, so appending races its claim, and email_data holds the rendered
 * variables rather than a list that could be extended. Left for later.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { formatBoolean } = require('../utils/dbCompat');
const emailProcessor = require('./emailProcessor');
const businessProfileService = require('./businessProfileService');
const customerAccountsService = require('./customerAccountsService');

const customerDisplayName = (c) => (c.display_name && c.display_name.trim())
  || [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
  || String(c.email || '').split('@')[0];

async function frontendBase() {
  return ((await getFrontendBaseUrl()) || 'http://localhost:3000').replace(/\/+$/, '');
}

async function businessName() {
  try {
    const { profile } = await businessProfileService.getProfile();
    return (profile && (profile.company_name || profile.legal_name)) || '';
  } catch (_) {
    return '';
  }
}

/**
 * The customer if a mail to them makes sense: active, with an address, able
 * to sign in (a passive customer has no password and could not follow the
 * link), and with documents effective for them.
 */
async function reachableCustomer(customerId) {
  const customer = await db('customer_accounts')
    .where({ id: customerId, is_active: formatBoolean(true) })
    .whereNotNull('password_hash')
    .first('id', 'email', 'display_name', 'first_name', 'last_name', 'preferred_language');
  if (!customer || !customer.email) return null;
  const features = await customerAccountsService.getEffectiveFeaturesForCustomer(customerId);
  if (!features || !features.documents) return null;
  return customer;
}

async function queue(type, recipient, data, ids, options = {}) {
  try {
    await emailProcessor.queueEmail(null, recipient, type, data, options);
    return 'queued';
  } catch (err) {
    logger.warn('Could not queue a customer document mail', { type, ...ids, error: err.message });
    return 'failed';
  }
}

/**
 * The studio shared `doc` with its customer. `notify` is the admin's choice
 * for this share; left undefined it follows customer_documents_notify_on_share.
 * @returns {Promise<'queued'|'skipped'|'failed'>}
 */
async function notifyShared(doc, { notify } = {}) {
  const ids = { documentId: doc.id, customerId: doc.customer_account_id };
  try {
    const wanted = notify === undefined || notify === null
      ? (await getAppSetting('customer_documents_notify_on_share', true)) !== false
      : notify === true;
    if (!wanted) return 'skipped';
    const customer = await reachableCustomer(doc.customer_account_id);
    if (!customer) return 'skipped';
    const event = doc.event_id ? await db('events').where({ id: doc.event_id }).first('event_name') : null;
    const base = await frontendBase();
    return await queue('customer_document_shared', customer.email, {
      customer_name: customerDisplayName(customer),
      business_name: await businessName(),
      document_title: doc.original_name,
      event_name: (event && event.event_name) || '',
      document_link: `${base}/customer/documents/${doc.id}`,
      dashboard_link: `${base}/customer/documents`,
      __language: customer.preferred_language || undefined,
    }, ids, { respectBusinessHours: true });
  } catch (err) {
    logger.warn('Could not prepare the document-shared mail', { ...ids, error: err.message });
    return 'failed';
  }
}

/** A customer uploaded `doc`: tell the business address, if one is set. */
async function notifyUploaded(doc) {
  const ids = { documentId: doc.id, customerId: doc.customer_account_id };
  try {
    const { profile } = await businessProfileService.getProfile();
    if (!profile || !profile.email) return 'skipped';
    const customer = await db('customer_accounts').where({ id: doc.customer_account_id })
      .first('email', 'display_name', 'first_name', 'last_name');
    if (!customer) return 'skipped';
    const base = await frontendBase();
    return await queue('customer_document_uploaded_admin', profile.email, {
      customer_name: customerDisplayName(customer),
      document_title: doc.original_name,
      admin_link: `${base}/admin/clients/accounts/${doc.customer_account_id}`,
    }, ids);
  } catch (err) {
    logger.warn('Could not prepare the document-uploaded mail', { ...ids, error: err.message });
    return 'failed';
  }
}

/** The studio rejected the customer's own upload `doc`. */
async function notifyRejected(doc) {
  const ids = { documentId: doc.id, customerId: doc.customer_account_id };
  try {
    if (doc.uploader_type !== 'customer') return 'skipped';
    const customer = await reachableCustomer(doc.customer_account_id);
    if (!customer) return 'skipped';
    const base = await frontendBase();
    return await queue('customer_document_reviewed', customer.email, {
      customer_name: customerDisplayName(customer),
      business_name: await businessName(),
      document_title: doc.original_name,
      review_note: doc.review_note || '',
      document_link: `${base}/customer/documents/${doc.id}`,
      __language: customer.preferred_language || undefined,
    }, ids, { respectBusinessHours: true });
  } catch (err) {
    logger.warn('Could not prepare the document-rejected mail', { ...ids, error: err.message });
    return 'failed';
  }
}

/**
 * The studio asked the customer for a document (slice 10), or — with
 * `reminder: true` — a step of the reminder ladder came due. The link opens
 * the documents page with the request preselected.
 */
async function notifyRequest(request, { reminder = false, notify } = {}) {
  const ids = { requestId: request.id, customerId: request.customer_account_id };
  try {
    if (notify === false) return 'skipped';
    const customer = await reachableCustomer(request.customer_account_id);
    if (!customer) return 'skipped';
    const base = await frontendBase();
    return await queue(reminder ? 'customer_document_request_reminder' : 'customer_document_requested', customer.email, {
      customer_name: customerDisplayName(customer),
      business_name: await businessName(),
      request_title: request.title,
      request_note: request.note || '',
      // Formatted here: the queue only formats its own date variables. A
      // calendar day, named by its UTC date as the portal shows it — the
      // server's timezone would move it a day either side.
      due_date: request.due_at
        ? await require('../utils/dateFormatter').formatDate(
          new Date(request.due_at).toISOString().slice(0, 10), customer.preferred_language || 'en')
        : '',
      upload_link: `${base}/customer/documents?request=${request.id}`,
      __language: customer.preferred_language || undefined,
    }, ids, { respectBusinessHours: true });
  } catch (err) {
    logger.warn('Could not prepare the document-request mail', { ...ids, error: err.message });
    return 'failed';
  }
}

/**
 * Workflow hooks (document.shared / document.uploaded / document.requested). Best effort: the
 * engine is feature-gated and never throws into the caller. An automated
 * follow-up built on these triggers gets the engine's own approval gate; the
 * admin's click on Share is the approval for the direct mail above.
 */
async function emitDocumentWorkflow(trigger, doc, dedupSuffix = null) {
  const isRequest = trigger === 'document.requested';
  try {
    // send_email's "Customer" recipient reads customerEmail (as on the quote
    // triggers); only a customer the direct mails would reach gets one.
    const customer = await reachableCustomer(doc.customer_account_id);
    const customerEmail = customer ? customer.email : null;
    await require('./workflows').emitWorkflowEvent(trigger, {
      entityType: isRequest ? 'customer_document_request' : 'customer_document',
      entityId: doc.id,
      payload: isRequest
        ? { customerAccountId: doc.customer_account_id, customerEmail, requestId: doc.id, eventId: doc.event_id || null }
        : { customerAccountId: doc.customer_account_id, customerEmail, documentId: doc.id, eventId: doc.event_id || null },
      dedupSuffix,
    });
  } catch (err) {
    logger.warn('Could not emit a document workflow event', { trigger, documentId: doc.id, error: err.message });
  }
}

module.exports = {
  notifyShared, notifyUploaded, notifyRejected, notifyRequest, emitDocumentWorkflow,
};
