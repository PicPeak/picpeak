'use strict';

/**
 * Line kinds, optional add-ons and discount promotions on CRM line items
 * (#1451, migration 215). Shared by quotes and invoices so both documents
 * agree on what counts toward the net.
 *
 * - `line_kind = 'discount'` is a promotion line ("Vereinsrabatt −300 CHF",
 *   "Early booking −10 %"). Where a quote is authored, its amount is resolved
 *   from the promotion snapshot: percentage promotions first, then fixed
 *   amounts, all from the subtotal of the regular lines and before VAT, and
 *   never more than that subtotal. The result is stored as a negative unit
 *   price with quantity 1. Everywhere else — invoice clones, storno,
 *   installments, monthly drafts — it is simply a negative line, so the
 *   existing "sum the top-level lines" loops stay correct unchanged.
 * - An optional add-on (`is_optional`) that isn't selected is left out of the
 *   totals, the PDF body and conversion. Sub-items follow their parent.
 *
 * Manual negative lines (a typed-in Rabatt) stay plain `item` lines.
 */

const { ensureInt, ensureNumber } = require('./numericHelpers');
const { formatBoolean } = require('./dbCompat');
const { AppError } = require('./errors');

const LINE_KINDS = ['item', 'discount'];
const UNITS = ['hour', 'day', 'piece', 'km', 'flat'];
const PRICE_MODES = ['fixed', 'hour', 'day'];
const BOUND_TO = ['hours', 'days'];
// Stored rate sources. The editor may also send 'auto' ("use my rate"),
// which the quote service resolves into 'customer' or 'default'.
const RATE_SOURCES = ['item', 'customer', 'default', 'manual'];
const PROMOTION_TYPES = ['percent', 'fixed'];

function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isTopLevel(li, parentKey = 'parent_position') {
  const parent = li[parentKey];
  return parent == null || parent === '';
}

function isDiscountLine(li) {
  return Boolean(li) && li.line_kind === 'discount';
}

/** `selected` defaults to true, so only an explicit "not selected" excludes. */
function isUnselectedOptional(li) {
  return isTruthyFlag(li.is_optional) && li.selected != null && !isTruthyFlag(li.selected);
}

/**
 * Promotion snapshots are stored as JSON text (portable across SQLite and
 * Postgres). Accepts the parsed object, the JSON string or nothing.
 */
function parsePromotionSnapshot(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function validatePromotionSnapshot(snapshot) {
  if (!snapshot) return null;
  const type = String(snapshot.type || '');
  if (!PROMOTION_TYPES.includes(type)) {
    throw new AppError('Discount line has an invalid promotion type', 400, 'LINE_ITEM_PROMOTION_INVALID');
  }
  const clean = {
    promotionId: snapshot.promotionId == null ? null : ensureInt(snapshot.promotionId),
    name: String(snapshot.name || '').slice(0, 128),
    type,
  };
  if (type === 'percent') {
    const percent = ensureNumber(snapshot.percent, NaN);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new AppError('Percentage promotions must be between 0 and 100', 400, 'LINE_ITEM_PROMOTION_INVALID');
    }
    clean.percent = percent;
  } else {
    const valueMinor = ensureInt(snapshot.valueMinor, -1);
    if (valueMinor < 0) {
      throw new AppError('Fixed promotions need a non-negative amount', 400, 'LINE_ITEM_PROMOTION_INVALID');
    }
    clean.valueMinor = valueMinor;
    clean.currency = snapshot.currency ? String(snapshot.currency).toUpperCase().slice(0, 3) : null;
  }
  return clean;
}

/**
 * Normalise the migration-215 fields on a payload (returns copies):
 * defaults `line_kind` to 'item', coerces the add-on flags, makes sub-items
 * follow their parent's optional/selected state, and enforces that a
 * discount line is a top-level line nobody nests under.
 */
function normalizeLineItems(items) {
  if (!Array.isArray(items)) return [];
  const byPosition = new Map();
  const normalized = items.map((li) => {
    const lineKind = li.line_kind == null || li.line_kind === '' ? 'item' : String(li.line_kind);
    if (!LINE_KINDS.includes(lineKind)) {
      throw new AppError(`Unknown line item kind: ${lineKind}`, 400, 'LINE_ITEM_KIND_INVALID');
    }
    const out = {
      ...li,
      line_kind: lineKind,
      is_optional: isTruthyFlag(li.is_optional),
      selected: li.selected == null ? true : isTruthyFlag(li.selected),
    };
    if (lineKind === 'discount') {
      if (!isTopLevel(out)) {
        throw new AppError('A discount line cannot be a sub-item', 400, 'LINE_ITEM_DISCOUNT_NESTED');
      }
      out.is_optional = false;
      out.selected = true;
      out.quantity = 1;
      out.discount_percent = 0;
      out.promotion_snapshot = validatePromotionSnapshot(parsePromotionSnapshot(li.promotion_snapshot));
    }
    if (li.position != null) byPosition.set(ensureInt(li.position), out);
    return out;
  });

  for (const li of normalized) {
    if (isTopLevel(li)) continue;
    const parent = byPosition.get(ensureInt(li.parent_position));
    if (!parent) continue; // validateLineItemHierarchy reports the missing parent
    if (parent.line_kind === 'discount') {
      throw new AppError('Nothing can be nested under a discount line', 400, 'LINE_ITEM_DISCOUNT_NESTED');
    }
    li.is_optional = parent.is_optional;
    li.selected = parent.selected;
  }
  return normalized;
}

/**
 * The lines that count toward totals: everything except unselected optional
 * add-ons and the sub-items of one.
 */
function countedLineItems(items, { parentKey = 'parent_position', positionKey = 'position' } = {}) {
  if (!Array.isArray(items)) return [];
  const excludedParents = new Set();
  for (const li of items) {
    if (isTopLevel(li, parentKey) && isUnselectedOptional(li)) excludedParents.add(ensureInt(li[positionKey]));
  }
  return items.filter((li) => {
    if (isUnselectedOptional(li)) return false;
    return isTopLevel(li, parentKey) || !excludedParents.has(ensureInt(li[parentKey]));
  });
}

/**
 * Resolve the amounts of the discount lines in place. Expects every other
 * line's `line_total_minor` to be computed already, including the parent
 * totals that derive from priced sub-items.
 *
 * Percentage promotions come first, then fixed amounts, all taken from the
 * regular subtotal (counted top-level non-discount lines). The combined
 * discount is capped at that subtotal, so a quote can never go negative
 * through promotions. A discount line without a snapshot keeps its stored
 * amount (still capped).
 */
function resolveDiscountLines(items, { parentKey = 'parent_position' } = {}) {
  const counted = countedLineItems(items, { parentKey });
  const subtotal = counted
    .filter((li) => isTopLevel(li, parentKey) && !isDiscountLine(li))
    .reduce((sum, li) => sum + ensureInt(li.line_total_minor), 0);
  const discounts = counted.filter(isDiscountLine);
  const typeOf = (li) => parsePromotionSnapshot(li.promotion_snapshot)?.type;
  const ordered = [
    ...discounts.filter((li) => typeOf(li) === 'percent'),
    ...discounts.filter((li) => typeOf(li) !== 'percent'),
  ];

  let remaining = Math.max(0, subtotal);
  for (const line of ordered) {
    const snapshot = parsePromotionSnapshot(line.promotion_snapshot);
    let amount;
    if (snapshot && snapshot.type === 'percent') {
      amount = Math.round(Math.max(0, subtotal) * Math.min(100, Math.max(0, ensureNumber(snapshot.percent, 0))) / 100);
    } else if (snapshot && snapshot.type === 'fixed') {
      amount = Math.max(0, ensureInt(snapshot.valueMinor));
    } else {
      amount = Math.max(0, -ensureInt(line.unit_price_minor));
    }
    amount = Math.min(amount, remaining);
    remaining -= amount;
    line.quantity = 1;
    line.discount_percent = 0;
    line.unit_price_minor = -amount;
    line.line_total_minor = -amount;
  }
  return items;
}

/**
 * Migration-215 columns for a line-item DB row (quotes and invoices).
 * Invoices have no optional add-ons — unselected ones are dropped when a
 * quote converts — so `{ invoice: true }` stores every line as a plain,
 * selected one.
 */
function extendedLineColumns(li, { invoice = false } = {}) {
  const snapshot = parsePromotionSnapshot(li.promotion_snapshot);
  return {
    line_kind: li.line_kind || 'item',
    unit: li.unit || null,
    is_optional: formatBoolean(invoice ? false : isTruthyFlag(li.is_optional)),
    selected: formatBoolean(invoice || li.selected == null ? true : isTruthyFlag(li.selected)),
    price_mode: li.price_mode || null,
    rate_source: li.rate_source || null,
    bound_to: li.bound_to || null,
    promotion_snapshot: snapshot ? JSON.stringify(snapshot) : null,
  };
}

/** Editor payload (camelCase) → service line-item fields (snake_case). */
function lineItemFieldsFromApi(li) {
  const out = {};
  if (li.lineKind !== undefined) out.line_kind = li.lineKind || 'item';
  if (li.unit !== undefined) out.unit = li.unit || null;
  if (li.isOptional !== undefined) out.is_optional = Boolean(li.isOptional);
  if (li.selected !== undefined) out.selected = li.selected == null ? true : Boolean(li.selected);
  if (li.priceMode !== undefined) out.price_mode = li.priceMode || null;
  if (li.rateSource !== undefined) out.rate_source = li.rateSource || null;
  if (li.boundTo !== undefined) out.bound_to = li.boundTo || null;
  if (li.promotionSnapshot !== undefined) out.promotion_snapshot = li.promotionSnapshot || null;
  // Wire-only: the quote service turns it into promotion_snapshot.
  if (li.promotionId !== undefined && li.promotionId !== null && li.promotionId !== '') {
    out.promotion_id = ensureInt(li.promotionId);
  }
  return out;
}

/** Line-item DB row → migration-215 API fields (camelCase). */
function lineItemFieldsToApi(li) {
  return {
    lineKind: li.line_kind || 'item',
    unit: li.unit || null,
    isOptional: isTruthyFlag(li.is_optional),
    selected: li.selected == null ? true : isTruthyFlag(li.selected),
    priceMode: li.price_mode || null,
    rateSource: li.rate_source || null,
    boundTo: li.bound_to || null,
    promotionSnapshot: parsePromotionSnapshot(li.promotion_snapshot),
  };
}

module.exports = {
  LINE_KINDS,
  UNITS,
  PRICE_MODES,
  BOUND_TO,
  RATE_SOURCES,
  PROMOTION_TYPES,
  isTruthyFlag,
  isDiscountLine,
  isUnselectedOptional,
  parsePromotionSnapshot,
  validatePromotionSnapshot,
  normalizeLineItems,
  countedLineItems,
  resolveDiscountLines,
  extendedLineColumns,
  lineItemFieldsFromApi,
  lineItemFieldsToApi,
};
