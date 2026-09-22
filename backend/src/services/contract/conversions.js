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
const { resolveDefaultEventType } = require('../eventTypeService');
const { auditedInsert, auditedUpdate } = require('../accountingHistory');


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
  // Starts from the default template's published version (#1445), like a
  // new contract; resolved before the transaction.
  const templates = require('./templates');
  const version = await templates.resolveVersionForNewContract(null);

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
      template_id: version ? version.template_id : null,
      template_version_id: version ? version.id : null,
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
    const history = { actor: adminId, source: 'quote.convert.contract' };
    const inserted = await auditedInsert(trx, 'contracts', contractRow, history);
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // The template version's clauses — the same seeding createContract
    // uses (#1445; this used to be a second copy of the system-block loop).
    if (version) await templates.seedContractFromVersion(trx, contractId, version);

    // Back-pointer so the quote detail page can deep-link to its
    // resulting contract and the convert-to-event/invoice paths know
    // to refuse double conversion. Skipped silently when the column
    // hasn't migrated — the contract is still created cleanly.
    if (hasQuoteContractBackPointer) {
      await auditedUpdate(trx, 'quotes', { id: quote.id }, {
        converted_contract_id: contractId,
        updated_at: new Date(),
      }, history);
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
      await auditedUpdate(db, 'contracts', { id: contractId }, {
        converted_event_id: result.eventId,
        updated_at: new Date(),
      }, { actor: adminId, source: 'contract.convert.event' });
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

  // Event type: the configurable org default, else the resolved catch-all —
  // same chain as quoteService.convertToEvent. Never a hardcoded slug: the
  // admin may have renamed or deleted 'wedding' (#800).
  const eventType = (await getAppSetting('crm_default_event_type'))
    || (await resolveDefaultEventType());

  const eventCols = await db('events').columnInfo();
  const { getImageSecurityDefaults, resolveImageSecurityColumns } = require('../../routes/adminEvents/helpers');
  const imageSecurityColumns = resolveImageSecurityColumns({}, await getImageSecurityDefaults());
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
    event_type: eventType,
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
    // #1296 — a signed standalone contract converts straight to a gallery
    // here, without going through quoteService, so the global Image Security
    // defaults have to be applied on this path too. Not inside a transaction,
    // so the global db read is fine.
    ...imageSecurityColumns,
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
    await auditedUpdate(db, 'contracts', { id: contractId }, {
      converted_event_id: eventId,
      updated_at: new Date(),
    }, { actor: adminId, source: 'contract.convert.event' });
  }

  try {
    await logActivity('contract_converted_to_empty_event',
      { contractId, eventId }, eventId, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  return { eventId, alreadyConverted: false };
}

// A claim older than this without a matching invoice is assumed to belong
// to a request that crashed between winning the claim and finishing the
// insert (process killed, connection dropped, etc) rather than one still
// genuinely in flight — five minutes is comfortably longer than the
// invoice-numbering + insert path ever takes, short enough that a real
// crash doesn't wedge the contract for long. A clean throw releases the
// claim immediately (see the try/catch below) so this cutoff only matters
// for crashes the catch never ran for.
const INVOICE_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * Compare-and-set claim on a contract before converting it to an invoice —
 * closes the race where two concurrent "Convert to invoice" requests (two
 * replicas, or a double click) both pass the status check and both insert
 * an invoice (#1589). Only one caller's UPDATE affects a row; that caller
 * proceeds, everyone else backs off. Returns the claim timestamp string if
 * this call won it, otherwise null.
 */
async function claimContractForInvoiceConversion(contractId, adminId) {
  const claimedAt = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - INVOICE_CLAIM_STALE_MS).toISOString();
  const count = await auditedUpdate(db, 'contracts',
    (q) => q.where({ id: contractId, status: 'fully_signed' })
      .andWhere((w) => w.whereNull('invoice_prepared_at').orWhere('invoice_prepared_at', '<', staleCutoff)),
    { invoice_prepared_at: claimedAt },
    { actor: adminId, source: 'contract.convert.invoices' });
  return count === 1 ? claimedAt : null;
}

/** Best-effort release of a claim this call took but didn't use (the
 * conversion itself threw). Only clears the claim if it's still exactly
 * the one this call set, so it never clobbers a claim someone else took
 * over via the staleness window. Never throws — a failed release just
 * leaves the claim to expire on its own staleness cutoff. */
async function releaseContractInvoiceClaim(contractId, adminId, claimedAt) {
  try {
    await auditedUpdate(db, 'contracts', { id: contractId, invoice_prepared_at: claimedAt },
      { invoice_prepared_at: null },
      { actor: adminId, source: 'contract.convert.invoices' });
  } catch (releaseErr) {
    logger.warn('Failed to release invoice conversion claim', { contractId, error: releaseErr.message });
  }
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
  // Migration 231 — skip the claim entirely on installs that haven't
  // migrated yet (same schema-drift pattern as the back-pointer above).
  const hasInvoicePreparedAt = await hasColumnCached('contracts', 'invoice_prepared_at');

  // Taken before branching so it covers both Path A and Path B below —
  // they're reached through the same contractId and the same
  // check-then-act shape, so one per-contract claim protects both.
  let claimedAt = null;
  if (hasInvoicePreparedAt) {
    claimedAt = await claimContractForInvoiceConversion(contractId, adminId);
    if (!claimedAt) {
      // Someone else already claimed this contract — a concurrent request
      // that's still running, or one that already finished. Either way,
      // hand back the invoice it produced instead of erroring, matching
      // the alreadyConverted pattern used elsewhere in this file.
      const existing = hasInvoiceContractBackPointer
        ? await db('invoices').where({ source_contract_id: contractId }).orderBy('id').select('id')
        : [];
      if (existing.length) {
        if (contract.source_quote_id) {
          return { installmentsCreated: existing.length, invoiceIds: existing.map((r) => r.id), alreadyConverted: true };
        }
        return { installmentsCreated: 1, invoiceId: existing[0].id, alreadyConverted: true };
      }
      // Claimed but no invoice yet, and not stale enough to re-claim —
      // a conversion is genuinely in progress right now.
      throw new AppError(
        'This contract is already being converted to an invoice. Try again shortly.',
        409, 'INVOICE_CONVERSION_IN_PROGRESS',
      );
    }
  }

  try {
    return await convertClaimedContractToInvoice(contract, contractId, adminId, hasInvoiceContractBackPointer);
  } catch (err) {
    if (claimedAt) await releaseContractInvoiceClaim(contractId, adminId, claimedAt);
    throw err;
  }
}

/** The actual conversion, run only once a claim (if the schema has the
 * column) has been won. Split out of convertToInvoiceOnly so the claim
 * can wrap it in a try/catch without re-indenting both branches. */
async function convertClaimedContractToInvoice(contract, contractId, adminId, hasInvoiceContractBackPointer) {
  // Path A: contract has a source quote → replay its line items +
  // payment plan via quoteService (full installment schedule).
  if (contract.source_quote_id) {
    const quoteService = require('../quoteService');
    const result = await quoteService.convertToInvoiceOnly(contract.source_quote_id, adminId, { fromContract: true });
    if (hasInvoiceContractBackPointer) {
      await auditedUpdate(db, 'invoices',
        (q) => q.where({ source_quote_id: contract.source_quote_id }).whereNull('source_contract_id'),
        { source_contract_id: contractId },
        { actor: adminId, source: 'contract.convert.invoices' });
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

  const invoiceRow = {
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
  // Claiming a number and persisting its invoice are one operation. If the
  // INSERT or its history row fails, the sequence update must roll back on
  // both databases.
  const { invoiceId, invoiceNumber } = await db.transaction(async (trx) => {
    const number = await invoiceService.nextInvoiceNumber(trx);
    const inserted = await auditedInsert(trx, 'invoices', { ...invoiceRow, invoice_number: number },
      { actor: adminId, source: 'contract.convert.invoices' });
    return { invoiceId: inserted[0].id, invoiceNumber: number };
  });

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
