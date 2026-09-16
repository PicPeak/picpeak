// Combined hours + re-bills billing (issue #866, Feature 3).
//
// When a per-event customer has BOTH open hour entries AND open re-bills, the
// admin can roll them into ONE client invoice. Hours and re-bills are NEVER
// merged into shared line items — they stay as distinct lines, grouped
// contiguously (hours first, then re-bills) with no section headers (product
// decision). Each source row is stamped with its own invoice line so the CRM
// panels keep deriving status correctly.
//
// Reuses the extracted build/stamp helpers from customerHoursService and
// expenseService so there is one code path for line-item construction and
// stamping. Lives in its own module to avoid a require cycle between those two
// services.

const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const invoiceService = require('./invoiceService');
const customerHoursService = require('./customerHoursService');
const expenseService = require('./expenseService');

/**
 * Bundle open hours and/or open re-bills for a per-event customer into one
 * invoice. At least one side must be requested AND non-empty.
 *
 * @param customerId
 * @param opts.includeHours    include unbilled hour entries
 * @param opts.includeRebills  include pending rebill/passthrough documents
 * @returns { invoiceId, entriesBilled, rebillsBilled }
 */
async function billCombinedForCustomer(customerId, { includeHours, includeRebills }, adminId) {
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  if (!customer) throw new AppError('Customer not found', 404);
  // Both underlying flows are per-event only (accumulator cadences auto-bill on
  // save/categorise); keep the combined path consistent.
  if (customer.billing_cadence === 'monthly' || customer.billing_cadence === 'manual') {
    throw new AppError(
      'Accumulator-mode customers (monthly / manual) bill automatically; combining is for per-event customers.',
      409, 'CADENCE_MISMATCH',
    );
  }
  if (!includeHours && !includeRebills) {
    throw new AppError('Nothing selected to bill', 400, 'NOTHING_SELECTED');
  }

  let logInfo = null;
  const result = await db.transaction(async (trx) => {
    const hours = includeHours
      ? await customerHoursService.buildUnbilledHourLineItems(trx, customer)
      : { entries: [], lineItems: [] };
    const rebills = includeRebills
      ? await expenseService.buildPendingRebillLineItems(trx, customer)
      : { docs: [], lineItems: [] };

    if (hours.entries.length === 0 && rebills.docs.length === 0) {
      throw new AppError('No open hours or re-bills to bill', 409, 'NO_OPEN_ITEMS');
    }

    // Contiguous, hours first then re-bills. Positions run 1..N across both
    // groups so each source row maps to exactly one invoice line.
    const lineItems = [];
    let pos = 0;
    for (const li of hours.lineItems) { pos += 1; lineItems.push({ ...li, position: pos }); }
    const hoursCount = pos;
    for (const li of rebills.lineItems) { pos += 1; lineItems.push({ ...li, position: pos }); }

    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: customer.id,
      lineItems,
    }, adminId, trx);
    const invoiceId = invoiceIds[0];

    const insertedLines = await trx('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('position', 'asc');
    const lineByPos = new Map(insertedLines.map((li) => [li.position, li.id]));

    if (hours.entries.length) {
      const hourLineIds = hours.entries.map((_, i) => lineByPos.get(i + 1) || null);
      await customerHoursService.stampBilledEntries(trx, hours.entries, invoiceId, hourLineIds, adminId);
    }
    if (rebills.docs.length) {
      const rebillLineIds = rebills.docs.map((_, i) => lineByPos.get(hoursCount + i + 1) || null);
      await expenseService.stampBilledRebills(trx, rebills.docs, invoiceId, rebillLineIds, adminId);
    }

    logInfo = {
      meta: { customerId: customer.id, invoiceId, entriesBilled: hours.entries.length, rebillsBilled: rebills.docs.length },
    };
    return { invoiceId, entriesBilled: hours.entries.length, rebillsBilled: rebills.docs.length };
  });
  // Audit log after commit (global-db write deadlocks inside the SQLite trx).
  if (logInfo) {
    try {
      await logActivity('combined_hours_rebills_billed', logInfo.meta, null, `admin:${adminId}`);
    } catch (_) { /* audit log is best-effort */ }
  }
  return result;
}

module.exports = { billCombinedForCustomer };
