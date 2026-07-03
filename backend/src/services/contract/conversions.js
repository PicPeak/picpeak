// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { hasColumnCached } = require('../../utils/schemaCache');
const businessProfileService = require('../businessProfileService');
const { ensureSystemBlocksSeeded } = require('../contractBlocksService');
const { ensureInt } = require('../../utils/numericHelpers');
const { adminActor, ensureCustomerActive, nextContractNumber } = require('./helpers');


/**
 * Convert an accepted quote into a fresh draft contract, pre-populating
 * the customer, language, title, valid-until window, and source_quote_id
 * back-pointer. Idempotent — if the quote already has a linked contract
 * (quote.converted_contract_id set), returns that contract's id without
 * creating a duplicate.
 *
 * Does NOT flip quote.status — the quote stays 'accepted' while the
 * contract is the active deliverable. The quote→event / quote→invoice
 * paths are gated against the converted_contract_id back-pointer so an
 * admin can't accidentally double-spend the quote.
 */
async function createFromQuote(quoteId, adminId) {
  // Same self-heal as createContract — the quote-conversion path seeds
  // the contract with every active system block, and the new
  // quote_line_items_table block needs to be present for it to land
  // in the default inclusion list.
  await ensureSystemBlocksSeeded();

  const quote = await db('quotes').where({ id: quoteId }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError(`Cannot convert a quote with status '${quote.status}'`, 409, 'QUOTE_NOT_ACCEPTED');
  }
  if (quote.converted_contract_id) {
    return { contractId: quote.converted_contract_id, alreadyConverted: true };
  }
  if (quote.converted_event_id) {
    throw new AppError(
      'This quote was already converted to an event. Create the contract from the event instead.',
      409, 'ALREADY_CONVERTED_TO_EVENT',
    );
  }

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerActive(customer);

  const profile = (await businessProfileService.getProfile()).profile;
  const validDays = ensureInt(await getAppSetting('crm_contracts_default_valid_days')) || 30;
  const issueDate = new Date().toISOString().slice(0, 10);
  const validUntil = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const title = quote.event_name
    ? `Contract — ${quote.event_name}`
    : `Contract from quote ${quote.quote_number}`;

  // Schema-drift safety: the lineage columns landed in migration 130
  // as in-place edits. Dev installs that ran 130 BEFORE that edit
  // won't have these columns yet. hasColumn() lets us skip the
  // affected writes instead of crashing with a generic 500.
  const hasContractSourceQuote = await hasColumnCached('contracts', 'source_quote_id');
  const hasQuoteContractBackPointer = await hasColumnCached('quotes', 'converted_contract_id');
  const hasContractEventCols = await hasColumnCached('contracts', 'event_name');

  // Resolve the actor BEFORE opening the transaction — adminActor reads
  // admin_users via the global db, which deadlocks the single-connection
  // SQLite pool if evaluated inside the trx (prepare_contract runs unattended).
  const actor = await adminActor(adminId);

  return await db.transaction(async (trx) => {
    // Pass trx so the sequence claim joins our outer transaction —
    // SQLite deadlocks otherwise (1-connection default).
    const contractNumber = await nextContractNumber(trx);
    const contractRow = {
      contract_number: contractNumber,
      customer_account_id: quote.customer_account_id,
      status: 'draft',
      language: quote.language || customer.preferred_language || profile?.default_locale || 'de',
      issue_date: issueDate,
      valid_until: validUntil,
      title,
      intro_text: quote.intro_text || null,
      outro_text: quote.outro_text || null,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    if (hasContractSourceQuote) contractRow.source_quote_id = quote.id;
    // Migration 140 — contract from quote inherits the quote's
    // deal_uuid so both documents belong to the same deal chain.
    // Falls back to a fresh UUID only if the source quote predates the
    // backfill (shouldn't happen on a migrated install, but defensive).
    contractRow.deal_uuid = quote.deal_uuid || crypto.randomUUID();
    // Propagate the quote's event snapshot — same fields the quote
    // already carries (set by createQuote). Means contract-from-quote
    // chains preserve "this contract is for the Wedding Doe / Müller"
    // labelling all the way through to the resulting invoice's
    // event_name field.
    if (hasContractEventCols) {
      contractRow.event_name = quote.event_name || null;
      contractRow.event_date = quote.event_date || null;
      contractRow.event_time_start = quote.event_time_start || null;
      contractRow.event_time_end = quote.event_time_end || null;
    }
    const inserted = await trx('contracts').insert(contractRow).returning('id');
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Seed every active system block. Same shape as createContract.
    // D.3 — batched insert (one DB round-trip vs N).
    const systemBlocks = await trx('contract_blocks')
      .where({ is_system: true, is_active: true })
      .orderBy(['section', 'display_order']);
    const sectionCounters = {};
    const inclusionRows = systemBlocks.map((block) => {
      sectionCounters[block.section] = (sectionCounters[block.section] || 0) + 1;
      return {
        contract_id: contractId,
        block_id: block.id,
        section: block.section,
        position: sectionCounters[block.section],
        body_text_snapshot: null,
        body_text_de_snapshot: null,
        included: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
    });
    if (inclusionRows.length > 0) {
      await trx('contract_block_inclusions').insert(inclusionRows);
    }

    // Back-pointer so the quote detail page can deep-link to its
    // resulting contract and the convert-to-event/invoice paths know
    // to refuse double conversion. Skipped silently when the column
    // hasn't migrated — the contract is still created cleanly.
    if (hasQuoteContractBackPointer) {
      await trx('quotes').where({ id: quote.id }).update({
        converted_contract_id: contractId,
        updated_at: new Date(),
      });
    }

    try {
      // Pass `trx` so the audit insert rides the transaction's connection;
      // the global db here deadlocks the single-connection SQLite pool.
      await logActivity('contract_created_from_quote',
        { contractId, contractNumber, quoteId: quote.id, quoteNumber: quote.quote_number },
        null, actor, trx);
    } catch (_) { /* logging is best-effort */ }
    logger.info('Contract created from quote', { adminId, contractId, contractNumber, quoteId: quote.id });
    return { contractId, alreadyConverted: false };
  });
}

/**
 * Convert a fully-signed contract into an event + scheduled invoices.
 * Delegates to quoteService.convertToEvent using the contract's
 * source_quote_id so the line items + payment plan come from the
 * original quote. The quote MUST still be in 'accepted' status (i.e.
 * not previously converted) — createFromQuote keeps it that way.
 *
 * On success the contract's converted_event_id is set (back-pointer)
 * and the source quote flips to 'converted'.
 */
async function convertToEvent(contractId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Cannot convert a contract with status '${contract.status}'. The contract must be fully signed by both parties first.`,
      409, 'CONTRACT_NOT_FULLY_SIGNED',
    );
  }
  if (contract.converted_event_id) {
    return { eventId: contract.converted_event_id, alreadyConverted: true };
  }

  const hasContractConvertedEvent = await hasColumnCached('contracts', 'converted_event_id');

  // Path A: source quote present → delegate to quoteService which
  // replays the full installment schedule into invoices alongside
  // the event row.
  if (contract.source_quote_id) {
    const quoteService = require('../quoteService');
    const result = await quoteService.convertToEvent(contract.source_quote_id, adminId, { fromContract: true });
    if (hasContractConvertedEvent) {
      await db('contracts').where({ id: contractId }).update({
        converted_event_id: result.eventId,
        updated_at: new Date(),
      });
    }
    try {
      await logActivity('contract_converted_to_event',
        { contractId, eventId: result.eventId, quoteId: contract.source_quote_id },
        result.eventId, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }
    return result;
  }

  // Path B: standalone contract → mint an empty placeholder event
  // row the admin fleshes out from the events admin page. Same
  // column-introspection trick quoteService uses so installs with
  // old/new host_*/customer_* column variants both work.
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);
  const adminRow = await db('admin_users').where({ id: adminId }).first();
  const today = new Date();
  const oneYearFromNow = new Date(today.getTime());
  oneYearFromNow.setFullYear(today.getFullYear() + 1);

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || customer.display_name || customer.company_name || contract.contract_number;
  const customerEmail = customer.email || `${contract.contract_number.toLowerCase()}@picpeak.local`;
  const adminEmail = adminRow?.email || customer.email || 'admin@picpeak.local';
  const placeholderHash = crypto.randomBytes(32).toString('hex');
  const shareToken = crypto.randomBytes(32).toString('hex');

  const eventCols = await db('events').columnInfo();
  const candidate = {
    slug: `contract-${contract.contract_number.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`,
    // Prefer the contract's event_name snapshot (set on the contract
    // editor or inherited from the source quote) over the contract
    // title. Falls back to a deterministic placeholder so the event
    // row never has a blank name.
    event_name: contract.event_name || contract.title || `Event ${contract.contract_number}`,
    event_date: contract.event_date || contract.issue_date,
    host_name: fullName,
    host_email: customerEmail,
    customer_name: fullName,
    customer_email: customerEmail,
    customer_phone: customer.phone,
    admin_email: adminEmail,
    event_type: 'wedding',
    password_hash: placeholderHash,
    share_link: shareToken,
    share_token: shareToken,
    expires_at: oneYearFromNow,
    is_active: true,
    is_archived: false,
    is_draft: true,
    created_by: adminId,
    quote_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const eventRow = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (Object.prototype.hasOwnProperty.call(eventCols, k)) eventRow[k] = v;
  }
  const inserted = await db('events').insert(eventRow).returning('id');
  const eventId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  // Link the customer so they see the event on their portal once
  // the admin activates it. Best-effort — older installs without
  // the junction table still get the event row.
  try {
    if (await db.schema.hasTable('event_customer_assignments')) {
      await db('event_customer_assignments').insert({
        event_id: eventId,
        customer_account_id: customer.id,
        assigned_by_admin_id: adminId,
        assigned_at: new Date(),
      });
    }
  } catch (_) { /* best-effort */ }

  if (hasContractConvertedEvent) {
    await db('contracts').where({ id: contractId }).update({
      converted_event_id: eventId,
      updated_at: new Date(),
    });
  }

  try {
    await logActivity('contract_converted_to_empty_event',
      { contractId, eventId }, eventId, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  return { eventId, alreadyConverted: false };
}

/**
 * Convert a fully-signed contract directly into invoice(s) without
 * creating an event row. Same delegation pattern as convertToEvent.
 */
async function convertToInvoiceOnly(contractId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Cannot convert a contract with status '${contract.status}'. The contract must be fully signed by both parties first.`,
      409, 'CONTRACT_NOT_FULLY_SIGNED',
    );
  }

  // Schema-drift guard — the lineage columns are in-place edits to
  // migration 130. Skip the back-pointer update silently when the
  // column hasn't migrated yet.
  const hasInvoiceContractBackPointer = await hasColumnCached('invoices', 'source_contract_id');

  // Path A: contract has a source quote → replay its line items +
  // payment plan via quoteService (full installment schedule).
  if (contract.source_quote_id) {
    const quoteService = require('../quoteService');
    const result = await quoteService.convertToInvoiceOnly(contract.source_quote_id, adminId, { fromContract: true });
    if (hasInvoiceContractBackPointer) {
      await db('invoices')
        .where({ source_quote_id: contract.source_quote_id })
        .whereNull('source_contract_id')
        .update({ source_contract_id: contractId });
    }
    try {
      await logActivity('contract_converted_to_invoices',
        { contractId, quoteId: contract.source_quote_id, installments: result.installmentsCreated },
        null, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }
    return result;
  }

  // Path B: standalone contract (no source quote) → direct DB insert
  // of an empty draft. We deliberately bypass invoiceService.createInvoice
  // because that runs ensureCustomerCanBill, which throws if the
  // customer doesn't have feature_bills enabled. Admin clicking
  // "Convert to invoice" on the contract detail page IS the
  // authorisation; the admin will fill in line items manually before
  // sending.
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  const invoiceService = require('../invoiceService');
  const profile = (await businessProfileService.getProfile()).profile || {};
  const currency = (profile.default_currency || 'CHF').toUpperCase();
  const language = contract.language || customer.preferred_language || profile.default_locale || 'de';
  const issueDate = new Date().toISOString().slice(0, 10);
  const netDays = ensureInt(await getAppSetting('crm_payment_default_net_days')) || 30;
  const dueDate = new Date(Date.now() + netDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Pre-resolve which event-snapshot columns the invoices table has
  // (migration 123) so we can copy contract.event_name etc onto the
  // new invoice. Falls back to contract.title when event_name is
  // empty — gives standalone contracts a useful label even when
  // the admin didn't fill out the event field.
  const invoiceHasEventName = await hasColumnCached('invoices', 'event_name');
  const eventNameSnapshot = (contract.event_name || contract.title || null);

  const invoiceNumber = await invoiceService.nextInvoiceNumber();
  const invoiceRow = {
    invoice_number: invoiceNumber,
    customer_account_id: contract.customer_account_id,
    source_quote_id: null,
    event_id: null,
    language,
    currency,
    issue_date: issueDate,
    due_date: dueDate,
    installment_index: 0,
    installment_total: 1,
    status: 'scheduled',
    net_amount_minor: 0,
    vat_rate: 0,
    vat_amount_minor: 0,
    shipping_amount_minor: 0,
    total_amount_minor: 0,
    paid_amount_minor: 0,
    reminder_level: 0,
    late_fee_amount_minor: 0,
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  if (hasInvoiceContractBackPointer) invoiceRow.source_contract_id = contractId;
  // Migration 140 — invoice inherits the contract's deal_uuid so the
  // contract + invoice belong to the same deal chain. Fresh UUID if
  // the contract predates the backfill (defensive).
  invoiceRow.deal_uuid = contract.deal_uuid || crypto.randomUUID();
  // Snapshot the contract's event fields onto the invoice so the
  // BillDetailPage + customer portal show the same "Wedding Doe /
  // Müller" label that the contract carries. event_name is also the
  // field the dunning emails reference in their templates.
  if (invoiceHasEventName) {
    invoiceRow.event_name = eventNameSnapshot;
    invoiceRow.event_date = contract.event_date || null;
    invoiceRow.event_time_start = contract.event_time_start || null;
    invoiceRow.event_time_end = contract.event_time_end || null;
  }
  const inserted = await db('invoices').insert(invoiceRow).returning('id');
  const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  try {
    await logActivity('contract_converted_to_empty_invoice',
      { contractId, invoiceId, invoiceNumber }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  // Match the result shape of the source-quote path so the frontend
  // toast can use the same translation key. `installmentsCreated` is
  // always 1 here (single empty invoice).
  return { installmentsCreated: 1, invoiceId };
}
module.exports = {
  createFromQuote,
  convertToEvent,
  convertToInvoiceOnly,
};
