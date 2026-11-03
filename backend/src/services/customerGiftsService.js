/**
 * Customer gifts and gift stock (migration 343).
 *
 * Who qualifies is worked out from paid invoices when a list loads
 * (customerGiftRules); only an admin's decisions are stored. Three rules the
 * rest of the code relies on:
 *   - a gift and its stock movement are written in one transaction, and the
 *     count is checked inside it, so two gifts can't take the last unit;
 *   - stock is always the sum of the movements, never a stored total;
 *   - gift data is admin-only and never reaches the customer portal;
 *   - who qualifies is read across all invoices, not the viewing admin's own,
 *     so every admin sees the same list. Booking counts and payment dates only
 *     reach an admin who can open every invoice behind them.
 *
 * Activity is logged after commit: a global-db write inside a transaction
 * deadlocks on the single SQLite connection.
 */

const { db, logActivity } = require('../database/db');
const { withTrustedCrmAccess } = require('../database/crmAccess');
const { AppError, NotFoundError } = require('../utils/errors');
const { isUniqueViolation } = require('../utils/dbErrors');
const { formatBoolean } = require('../utils/dbCompat');
const { auditedUpdate } = require('./accountingHistory');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const { ownedBy } = require('./expenseAccess');
const businessProfileService = require('./businessProfileService');
const rules = require('./customerGiftRules');

const ERASED_EMAIL_SUFFIX = '@deleted.invalid';

const SETTING_KEYS = {
  milestoneYears: 'gift_milestone_years',
  minBookings: 'gift_min_bookings',
  activityMinInvoices: 'gift_activity_min_invoices',
  activityPeriodYears: 'gift_activity_period_years',
  rhythmMarginMonths: 'gift_rhythm_margin_months',
  graceDays: 'gift_grace_days',
};

// Not a real purchase record: the inbox set these aside.
const UNUSABLE_INVOICE_STATUSES = ['declined', 'duplicate'];

const adminActor = (admin) => ({
  type: 'admin', id: admin.id, name: admin.username || `Admin #${admin.id}`,
});

const insertedId = (inserted) => (typeof inserted === 'object' ? inserted.id : inserted);

/** Date and timestamp columns read back differently per engine; this is the one shape. */
function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const today = () => toDateOnly(new Date());

/** A payment entered without a time is stored as UTC midnight, the day before west of UTC. */
function paidDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime() % rules.DAY_MS === 0 ? date.toISOString().slice(0, 10) : toDateOnly(date);
}

// ---- rules ---------------------------------------------------------------

async function getRules() {
  const rows = await db('app_settings')
    .whereIn('setting_key', Object.values(SETTING_KEYS))
    .select('setting_key', 'setting_value');
  const stored = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
  const out = { ...rules.DEFAULT_RULES };
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    if (!stored.has(key)) continue;
    // A json column: PostgreSQL hands back the parsed value, SQLite the text.
    let value = stored.get(key);
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        continue; // A hand-edited value that isn't JSON keeps the default.
      }
    }
    out[field] = value;
  }
  return out;
}

async function updateRules(input, admin) {
  const previous = await getRules();
  const changes = { ...input };
  if (changes.milestoneYears) {
    changes.milestoneYears = [...new Set(changes.milestoneYears.map(Number))].sort((a, b) => a - b);
  }
  // Only what was sent, so a default the admin never touched stays a default.
  await db.transaction(async (trx) => {
    for (const [field, value] of Object.entries(changes)) {
      await trx('app_settings')
        .insert({
          setting_key: SETTING_KEYS[field],
          setting_value: JSON.stringify(value),
          setting_type: Array.isArray(value) ? 'json' : 'number',
        })
        .onConflict('setting_key')
        .merge(['setting_value']);
    }
  });
  await logActivity('customer_gift_rules_updated', { previous, changes }, null, adminActor(admin));
  return getRules();
}

// ---- items and stock -----------------------------------------------------

function stockQuery(conn) {
  return conn('gift_stock_movements')
    .groupBy('gift_item_id')
    .select('gift_item_id')
    .sum({ stock: 'quantity_delta' });
}

async function stockOf(conn, itemId) {
  const row = await stockQuery(conn).where({ gift_item_id: itemId }).first();
  return Number(row?.stock || 0);
}

/** On PostgreSQL holds the item's row, so the count read next can't go stale. */
async function lockItem(trx, itemId) {
  const query = trx('gift_items').where({ id: itemId });
  if (trx.client.config.client === 'pg') query.forUpdate();
  const item = await query.first();
  if (!item) throw new NotFoundError('Gift item', itemId);
  return item;
}

function itemToApi(row, stock) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    isArchived: Boolean(row.is_archived),
    stock,
  };
}

async function listItems({ includeArchived = false } = {}) {
  const query = db('gift_items').orderBy('name');
  if (!includeArchived) query.where({ is_archived: formatBoolean(false) });
  const [items, stocks] = await Promise.all([query, stockQuery(db)]);
  const stockById = new Map(stocks.map((row) => [row.gift_item_id, Number(row.stock || 0)]));
  return items.map((item) => itemToApi(item, stockById.get(item.id) || 0));
}

async function createItem({ name, description }, admin) {
  const [inserted] = await db('gift_items').insert({
    name,
    description: description || null,
    created_by_admin_id: admin.id,
  }).returning('id');
  const id = insertedId(inserted);
  await logActivity('customer_gift_item_created', { giftItemId: id, name }, null, adminActor(admin));
  return itemToApi(await db('gift_items').where({ id }).first(), 0);
}

async function updateItem(id, fields, admin) {
  const existing = await db('gift_items').where({ id }).first();
  if (!existing) throw new NotFoundError('Gift item', id);
  const updates = { updated_at: new Date().toISOString() };
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.description !== undefined) updates.description = fields.description || null;
  if (fields.isArchived !== undefined) updates.is_archived = formatBoolean(fields.isArchived);
  await db('gift_items').where({ id }).update(updates);
  await logActivity('customer_gift_item_updated', { giftItemId: id, name: updates.name || existing.name }, null, adminActor(admin));
  return itemToApi(await db('gift_items').where({ id }).first(), await stockOf(db, id));
}

function movementToApi(row) {
  return {
    id: row.id,
    kind: row.kind,
    quantityDelta: row.quantity_delta,
    unitCostMinor: row.unit_cost_minor === null ? null : Number(row.unit_cost_minor),
    currency: row.currency || null,
    inboundDocumentId: row.inbound_document_id || null,
    reason: row.reason || null,
    occurredOn: toDateOnly(row.occurred_on),
  };
}

async function listMovements(itemId, { showCosts = false } = {}) {
  const item = await db('gift_items').where({ id: itemId }).first();
  if (!item) throw new NotFoundError('Gift item', itemId);
  const rows = await db('gift_stock_movements')
    .where({ gift_item_id: itemId })
    .orderBy('occurred_on', 'desc')
    .orderBy('id', 'desc');
  // Supplier prices and invoices sit behind accounting, as linking one does.
  return rows.map(movementToApi).map((movement) => (showCosts
    ? movement
    : { ...movement, unitCostMinor: null, currency: null, inboundDocumentId: null }));
}

/**
 * Add stock. A supplier invoice is optional and needs both the incoming
 * invoices feature and access to accounting: it opens a document, so it gets
 * the same gate the document has.
 */
async function addStock(itemId, input, admin, { canReadInvoices }) {
  const { quantity, unitCostMinor, currency, occurredOn, inboundDocumentId, note } = input;
  let invoice = null;
  if (inboundDocumentId) {
    if (!canReadInvoices || !(await isFeatureEnabled('incomingInvoices'))) {
      throw new AppError('Linking a supplier invoice needs access to incoming invoices', 403, 'GIFT_INVOICE_FORBIDDEN');
    }
    invoice = await db('inbound_documents').where({ id: inboundDocumentId })
      .whereNotIn('status', UNUSABLE_INVOICE_STATUSES)
      .modify(ownedBy('inbound_documents'))
      .first();
    if (!invoice) throw new NotFoundError('Supplier invoice', inboundDocumentId);
  }
  const fallbackCurrency = invoice?.currency || (await businessProfileService.getProfile())?.default_currency;
  const movementId = await db.transaction(async (trx) => {
    await lockItem(trx, itemId);
    const [inserted] = await trx('gift_stock_movements').insert({
      gift_item_id: itemId,
      kind: 'purchase',
      quantity_delta: quantity,
      unit_cost_minor: unitCostMinor ?? null,
      currency: unitCostMinor === undefined || unitCostMinor === null
        ? null
        : (currency || fallbackCurrency || 'CHF').toUpperCase(),
      inbound_document_id: inboundDocumentId || null,
      reason: note || null,
      occurred_on: occurredOn || today(),
      created_by_admin_id: admin.id,
    }).returning('id');
    return insertedId(inserted);
  });
  await logActivity('customer_gift_stock_added', { giftItemId: itemId, quantity, inboundDocumentId: inboundDocumentId || null }, null, adminActor(admin));
  return movementToApi(await db('gift_stock_movements').where({ id: movementId }).first());
}

async function correctStock(itemId, { quantityDelta, reason, occurredOn }, admin) {
  const movementId = await db.transaction(async (trx) => {
    await lockItem(trx, itemId);
    if (await stockOf(trx, itemId) + quantityDelta < 0) {
      throw new AppError('A correction can\'t take stock below zero', 409, 'GIFT_STOCK_NEGATIVE');
    }
    const [inserted] = await trx('gift_stock_movements').insert({
      gift_item_id: itemId,
      kind: 'correction',
      quantity_delta: quantityDelta,
      reason,
      occurred_on: occurredOn || today(),
      created_by_admin_id: admin.id,
    }).returning('id');
    return insertedId(inserted);
  });
  await logActivity('customer_gift_stock_corrected', { giftItemId: itemId, quantityDelta, reason }, null, adminActor(admin));
  return movementToApi(await db('gift_stock_movements').where({ id: movementId }).first());
}

// ---- who qualifies -------------------------------------------------------

/** Paid invoices by customer. Storno rows and cancelled originals never count. */
const paidInvoices = () => db('invoices')
  .where({ status: 'paid', kind: 'invoice' })
  .whereNull('cancels_invoice_id')
  .select('id', 'customer_account_id', 'deal_uuid', 'paid_at', 'issue_date');

async function paymentsByCustomer(customerIds) {
  const query = paidInvoices();
  if (customerIds) query.whereIn('customer_account_id', customerIds);
  const rows = await withTrustedCrmAccess('customer gift milestones', () => query);
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row.customer_account_id) || [];
    list.push({
      key: row.deal_uuid || `invoice-${row.id}`,
      paidOn: row.paid_at ? paidDate(row.paid_at) : toDateOnly(row.issue_date),
    });
    out.set(row.customer_account_id, list);
  }
  return out;
}

/** How many paid invoices of each customer the viewing admin may open. */
async function readableInvoiceCounts() {
  const counts = new Map();
  for (const row of await paidInvoices()) {
    counts.set(row.customer_account_id, (counts.get(row.customer_account_id) || 0) + 1);
  }
  return counts;
}

function eligibleCustomers() {
  return db('customer_accounts')
    .where({ is_active: formatBoolean(true), no_gifts: formatBoolean(false) })
    .whereNot('email', 'like', `%${ERASED_EMAIL_SUFFIX}`)
    .select('id', 'display_name', 'company_name', 'email', 'gift_start_date_override');
}

function evaluateCustomer(customer, payments, giftRules, date) {
  return rules.evaluate({
    payments: payments.get(customer.id) || [],
    startDateOverride: toDateOnly(customer.gift_start_date_override),
    today: date,
    rules: giftRules,
  });
}

function suggestionToApi(customer, evaluation, showInvoiceFigures) {
  return {
    customerId: customer.id,
    customerName: customer.company_name || customer.display_name || customer.email,
    milestoneYears: evaluation.milestoneYears,
    milestoneDate: evaluation.milestoneDate,
    bookingCount: showInvoiceFigures ? evaluation.bookingCount : null,
    lastPaidOn: showInvoiceFigures ? evaluation.lastPaidOn : null,
    reason: showInvoiceFigures ? evaluation.reason || null : null,
  };
}

/** The two lists on the Gifts page. A customer waiting out the grace period is on neither. */
async function listSuggestions() {
  const [customers, payments, readable, closed, giftRules] = await Promise.all([
    eligibleCustomers(),
    paymentsByCustomer(),
    readableInvoiceCounts(),
    db('customer_gifts').whereNull('undone_at').whereNotNull('milestone_years')
      .select('customer_account_id', 'milestone_years'),
    getRules(),
  ]);
  // Milestones only go up: changing the rules or the start date must not bring
  // back an earlier one for a customer already past it.
  const highestClosed = new Map();
  for (const row of closed) {
    const highest = highestClosed.get(row.customer_account_id) || 0;
    highestClosed.set(row.customer_account_id, Math.max(highest, row.milestone_years));
  }
  const due = [];
  const notQualified = [];
  const date = today();
  for (const customer of customers) {
    const evaluation = evaluateCustomer(customer, payments, giftRules, date);
    if (evaluation.state !== 'due' && evaluation.state !== 'not_qualified') continue;
    if (evaluation.milestoneYears <= (highestClosed.get(customer.id) || 0)) continue;
    const paid = payments.get(customer.id)?.length || 0;
    const showFigures = paid > 0 && readable.get(customer.id) === paid;
    (evaluation.state === 'due' ? due : notQualified).push(suggestionToApi(customer, evaluation, showFigures));
  }
  const byDate = (a, b) => a.milestoneDate.localeCompare(b.milestoneDate);
  return { due: due.sort(byDate), notQualified: notQualified.sort(byDate) };
}

// ---- gifts ---------------------------------------------------------------

function giftToApi(row) {
  return {
    id: row.id,
    status: row.status,
    giftItemId: row.gift_item_id || null,
    itemName: row.item_name || null,
    milestoneYears: row.milestone_years ?? null,
    isOverride: Boolean(row.is_override),
    // The cost snapshot stays in the row: the customer routes need no
    // accounting right, so supplier costs are read on the movements only.
    note: row.note || null,
    giftDate: toDateOnly(row.gift_date),
    undone: Boolean(row.undone_at),
  };
}

async function customerOrThrow(customerId, conn = db) {
  const query = conn('customer_accounts').where({ id: customerId });
  if (conn.isTransaction && conn.client.config.client === 'pg') query.forUpdate();
  const customer = await query.first();
  if (!customer) throw new NotFoundError('Customer', customerId);
  return customer;
}

async function getCustomerGifts(customerId) {
  const customer = await customerOrThrow(customerId);
  const rows = await db('customer_gifts as g')
    .leftJoin('gift_items as i', 'i.id', 'g.gift_item_id')
    .where('g.customer_account_id', customerId)
    .orderBy('g.gift_date', 'desc')
    .orderBy('g.id', 'desc')
    .select('g.*', 'i.name as item_name');
  return {
    noGifts: Boolean(customer.no_gifts),
    startDateOverride: toDateOnly(customer.gift_start_date_override),
    gifts: rows.map(giftToApi),
  };
}

async function updateCustomerPreferences(customerId, { noGifts, startDateOverride }, admin) {
  const updates = {};
  if (noGifts !== undefined) updates.no_gifts = formatBoolean(noGifts);
  if (startDateOverride !== undefined) updates.gift_start_date_override = startDateOverride || null;
  await db.transaction(async (trx) => {
    await writableCustomerOrThrow(customerId, trx);
    if (Object.keys(updates).length === 0) return;
    await auditedUpdate(trx, 'customer_accounts', { id: customerId }, updates, {
      actor: admin.id, source: 'customer.gift_preferences',
    });
  });
  if (Object.keys(updates).length > 0) {
    await logActivity('customer_gift_preferences_updated', {
      customerId, noGifts, startDateChanged: startDateOverride !== undefined,
    }, null, adminActor(admin));
  }
  return getCustomerGifts(customerId);
}

/**
 * Erasure wiped this account's gift notes; nothing may write new ones. Inside a
 * transaction this holds the row on PostgreSQL, so an erasure can't land between
 * this check and the write.
 */
async function writableCustomerOrThrow(customerId, conn = db) {
  const customer = await customerOrThrow(customerId, conn);
  if (String(customer.email).endsWith(ERASED_EMAIL_SUFFIX)) {
    throw new AppError('This customer was erased', 409, 'GIFT_CUSTOMER_ERASED');
  }
  return customer;
}

const milestoneTaken = () => new AppError('This milestone is already closed', 409, 'GIFT_MILESTONE_CLOSED');

/** A closed milestone hides everything up to it, so only the customer's current one can be closed. */
async function assertCurrentMilestone(customer, milestoneYears) {
  const [payments, giftRules, highest] = await Promise.all([
    paymentsByCustomer([customer.id]),
    getRules(),
    db('customer_gifts')
      .where({ customer_account_id: customer.id })
      .whereNull('undone_at')
      .max({ years: 'milestone_years' })
      .first(),
  ]);
  const evaluation = evaluateCustomer(customer, payments, giftRules, today());
  if (evaluation.milestoneYears !== milestoneYears) {
    throw new AppError('This is not the customer\'s current milestone', 409, 'GIFT_MILESTONE_NOT_CURRENT');
  }
  if (milestoneYears <= Number(highest?.years || 0)) throw milestoneTaken();
}

async function latestPurchaseCost(trx, itemId) {
  const row = await trx('gift_stock_movements')
    .where({ gift_item_id: itemId, kind: 'purchase' })
    .whereNotNull('unit_cost_minor')
    .orderBy('occurred_on', 'desc')
    .orderBy('id', 'desc')
    .first();
  return row ? { unit_cost_minor: row.unit_cost_minor, currency: row.currency } : { unit_cost_minor: null, currency: null };
}

/**
 * Log a gift. `reduceStock: false` records a gift from before this feature,
 * which never came out of the counted stock. Without a milestone this is a gift
 * by hand; with one it closes that milestone. `isOverride` marks "Gift anyway".
 */
async function giveGift(customerId, input, admin) {
  const {
    giftItemId, giftDate, note, milestoneYears, isOverride = false, reduceStock = true,
  } = input;
  const customer = await writableCustomerOrThrow(customerId);
  if (milestoneYears) await assertCurrentMilestone(customer, milestoneYears);
  let id;
  try {
    id = await db.transaction(async (trx) => {
      await writableCustomerOrThrow(customerId, trx);
      const item = await lockItem(trx, giftItemId);
      if (item.is_archived) throw new AppError('This gift item is archived', 409, 'GIFT_ITEM_ARCHIVED');
      if (reduceStock && await stockOf(trx, giftItemId) < 1) {
        throw new AppError('This gift item is out of stock', 409, 'GIFT_OUT_OF_STOCK');
      }
      const date = giftDate || today();
      // A gift from before stock was tracked didn't cost today's price.
      const cost = reduceStock
        ? await latestPurchaseCost(trx, giftItemId)
        : { unit_cost_minor: null, currency: null };
      const [inserted] = await trx('customer_gifts').insert({
        customer_account_id: customerId,
        gift_item_id: giftItemId,
        status: 'given',
        milestone_years: milestoneYears ?? null,
        is_override: formatBoolean(isOverride),
        unit_cost_minor: cost.unit_cost_minor,
        currency: cost.currency,
        note: note || null,
        gift_date: date,
        created_by_admin_id: admin.id,
      }).returning('id');
      const giftId = insertedId(inserted);
      if (reduceStock) {
        await trx('gift_stock_movements').insert({
          gift_item_id: giftItemId,
          kind: 'gift',
          quantity_delta: -1,
          customer_gift_id: giftId,
          occurred_on: date,
          created_by_admin_id: admin.id,
        });
      }
      return giftId;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw milestoneTaken();
    throw err;
  }
  await logActivity('customer_gift_given', {
    customerId, giftId: id, giftItemId, milestoneYears: milestoneYears ?? null, isOverride,
  }, null, adminActor(admin));
  return getCustomerGifts(customerId);
}

/** Closes one milestone. The next one still comes up; `no_gifts` is the way to stop them all. */
async function declineMilestone(customerId, { milestoneYears, note }, admin) {
  const customer = await writableCustomerOrThrow(customerId);
  await assertCurrentMilestone(customer, milestoneYears);
  let id;
  try {
    id = await db.transaction(async (trx) => {
      await writableCustomerOrThrow(customerId, trx);
      const [inserted] = await trx('customer_gifts').insert({
        customer_account_id: customerId,
        status: 'declined',
        milestone_years: milestoneYears,
        note: note || null,
        gift_date: today(),
        created_by_admin_id: admin.id,
      }).returning('id');
      return insertedId(inserted);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw milestoneTaken();
    throw err;
  }
  await logActivity('customer_gift_declined', { customerId, giftId: id, milestoneYears }, null, adminActor(admin));
  return getCustomerGifts(customerId);
}

/** Undoes a gift or decline. A gift's stock comes back; the milestone reopens unless a later one is closed. */
async function undo(giftId, admin) {
  const customerId = await db.transaction(async (trx) => {
    const query = trx('customer_gifts').where({ id: giftId });
    if (trx.client.config.client === 'pg') query.forUpdate();
    const gift = await query.first();
    if (!gift) throw new NotFoundError('Gift', giftId);
    if (gift.undone_at) throw new AppError('This entry is already undone', 409, 'GIFT_ALREADY_UNDONE');
    await trx('customer_gifts').where({ id: giftId }).update({
      undone_at: new Date().toISOString(),
      undone_by_admin_id: admin.id,
    });
    const movement = await trx('gift_stock_movements').where({ customer_gift_id: giftId, kind: 'gift' }).first();
    if (movement) {
      await trx('gift_stock_movements').insert({
        gift_item_id: movement.gift_item_id,
        kind: 'gift_undone',
        quantity_delta: 1,
        customer_gift_id: giftId,
        occurred_on: today(),
        created_by_admin_id: admin.id,
      });
    }
    return gift.customer_account_id;
  });
  await logActivity('customer_gift_undone', { customerId, giftId }, null, adminActor(admin));
  return getCustomerGifts(customerId);
}

/** Part of customer erasure. Called on the erasure's transaction. */
async function forgetCustomer(trx, customerId, actor) {
  await trx('customer_gifts').where({ customer_account_id: customerId }).update({ note: null });
  await auditedUpdate(trx, 'customer_accounts', { id: customerId }, { gift_start_date_override: null, no_gifts: formatBoolean(false) }, {
    actor, source: 'customer.erase',
  });
}

module.exports = {
  getRules,
  updateRules,
  listItems,
  createItem,
  updateItem,
  listMovements,
  addStock,
  correctStock,
  listSuggestions,
  getCustomerGifts,
  updateCustomerPreferences,
  giveGift,
  declineMilestone,
  undo,
  forgetCustomer,
};
