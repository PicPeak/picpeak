'use strict';

/**
 * Sub-cent rounding reconciliation for CRM documents (quotes + invoices).
 *
 * Each line's total is rounded to the whole minor unit (Rappen/cent)
 * BEFORE the net is summed — so for quantities with fractional tails
 * (e.g. 2.5 h × 32.25 = 80.625 → 80.63) the sum of the rounded lines can
 * drift a few minor units away from the "pure" product. Worked example
 * from a real invoice: 68 h × 32.25 = 2193.00, but the 21 individually
 * rounded line totals sum to 2193.02.
 *
 * This is the standard "sum of rounded lines" convention (Stripe,
 * QuickBooks, Xero all do the same) and it foots — the printed line
 * amounts genuinely add up to the shown total. But some issuers prefer
 * the total to match the customer's mental arithmetic (hours × rate).
 *
 * When the `crm_invoice_round_total` setting is on, the create paths
 * replace the stored net with `cleanNetMinor(...)` — the full-precision
 * sum rounded ONCE — and the drift is surfaced to the reader as an
 * explicit "Rundung" row, derived at render time as
 * `storedNet − Σ(line totals)` (see the render-context builders). When
 * the setting is off, stored net === Σ(line totals) and the adjustment
 * is zero, so the behaviour is unchanged.
 */

function ensureNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function ensureInt(v, d = 0) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
}

/**
 * Full-precision contribution of one line in minor units (NOT rounded):
 *   quantity × unit_price_minor × (1 − discount%/100)
 */
function exactLineMinor(li) {
  const qty = ensureNumber(li.quantity, 1);
  const unit = ensureInt(li.unit_price_minor);
  const disc = Math.max(0, Math.min(100, ensureNumber(li.discount_percent, 0)));
  return qty * unit * (1 - disc / 100);
}

function isTopLevel(li, parentKey) {
  const p = li[parentKey];
  return p == null || p === '';
}

/**
 * Clean net = round(Σ full-precision contributions of the rows that roll
 * into net). Mirrors the rounded-net summation exactly — top-level rows
 * only, with a parent whose priced sub-items override it contributing
 * its children instead of itself (migration 119 hierarchy) — but sums at
 * full precision and rounds ONCE at the very end.
 *
 * `items` must carry quantity / unit_price_minor / discount_percent and,
 * for the hierarchy resolution, `line_total_minor` (the already-rounded
 * per-line value, used only to decide whether a parent is overridden by
 * priced children — same test as computeTotals / resolveParentTotals).
 *
 * @param {Array} items
 * @param {{parentKey?: string, positionKey?: string}} opts
 * @returns {number} clean net in minor units
 */
function cleanNetMinor(items, { parentKey = 'parent_position', positionKey = 'position' } = {}) {
  const childrenByParent = new Map();
  for (const li of items) {
    if (isTopLevel(li, parentKey)) continue;
    const key = ensureInt(li[parentKey]);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(li);
  }

  let exact = 0;
  for (const li of items) {
    if (!isTopLevel(li, parentKey)) continue; // sub-items roll into their parent
    const kids = childrenByParent.get(ensureInt(li[positionKey])) || [];
    const pricedKids = kids.filter((c) => ensureInt(c.unit_price_minor) > 0);
    const pricedKidsRounded = pricedKids.reduce((s, c) => s + ensureInt(c.line_total_minor), 0);
    // Same override test as computeTotals phase 2: a parent with at least
    // one priced sub-item derives its total from those children.
    if (pricedKidsRounded > 0) {
      for (const c of pricedKids) exact += exactLineMinor(c);
    } else {
      exact += exactLineMinor(li);
    }
  }
  return Math.round(exact);
}

module.exports = { cleanNetMinor, exactLineMinor };
