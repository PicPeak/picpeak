/**
 * Editor-side mirror of backend/src/utils/lineItemTotals.js (#1451).
 *
 * The server is the source of truth — it recomputes everything on save.
 * This mirror only keeps the editor's live preview in step with what will
 * be stored:
 *   - an optional add-on that isn't selected stays out of the totals, and
 *     so do its sub-items;
 *   - discount lines (promotions) take their amount from the regular
 *     subtotal: percentage promotions first, then fixed amounts, capped at
 *     the subtotal.
 *
 * Amounts here are MAJOR units (the editor's form state).
 */

export type LineKind = 'item' | 'discount';
export type LineUnit = 'hour' | 'day' | 'piece' | 'km' | 'flat';
export type PriceMode = 'fixed' | 'hour' | 'day';
export type BoundTo = 'hours' | 'days';
/** 'auto' asks the server to apply the customer's or the default rate. */
export type RateSource = 'auto' | 'item' | 'customer' | 'default' | 'manual';

export interface PromotionSnapshot {
  promotionId?: number | null;
  name?: string;
  type: 'percent' | 'fixed';
  percent?: number;
  valueMinor?: number;
  currency?: string | null;
}

export interface TotalsLine {
  position: number;
  parentPosition?: number | null;
  lineKind?: LineKind;
  isOptional?: boolean;
  selected?: boolean;
  promotionSnapshot?: PromotionSnapshot | null;
}

const isTopLevel = (li: TotalsLine) => li.parentPosition == null;

export const isDiscountLine = (li: TotalsLine) => li.lineKind === 'discount';

/** `selected` defaults to true — only an explicit "not selected" excludes. */
export const isUnselectedOptional = (li: TotalsLine) => !!li.isOptional && li.selected === false;

/** The lines that count toward totals. */
export function countedLines<T extends TotalsLine>(items: T[]): T[] {
  const excludedParents = new Set(
    items.filter((li) => isTopLevel(li) && isUnselectedOptional(li)).map((li) => li.position),
  );
  return items.filter((li) => {
    if (isUnselectedOptional(li)) return false;
    return isTopLevel(li) || !excludedParents.has(li.parentPosition as number);
  });
}

/**
 * Amounts (major units, positive) of the discount lines, keyed by position.
 * `regularSubtotal` is the sum of the counted top-level non-discount lines.
 * A discount line without a snapshot keeps its typed amount.
 */
export function resolveDiscountAmounts(
  items: Array<TotalsLine & { unitPrice?: number }>,
  regularSubtotal: number,
): Map<number, number> {
  const discounts = countedLines(items).filter(isDiscountLine);
  const ordered = [
    ...discounts.filter((li) => li.promotionSnapshot?.type === 'percent'),
    ...discounts.filter((li) => li.promotionSnapshot?.type !== 'percent'),
  ];
  const base = Math.max(0, regularSubtotal);
  let remaining = base;
  const amounts = new Map<number, number>();
  for (const line of ordered) {
    const snap = line.promotionSnapshot;
    let amount: number;
    if (snap?.type === 'percent') {
      amount = Math.round(base * Math.min(100, Math.max(0, Number(snap.percent) || 0))) / 100;
    } else if (snap?.type === 'fixed') {
      amount = Math.max(0, Number(snap.valueMinor) || 0) / 100;
    } else {
      amount = Math.max(0, -(Number(line.unitPrice) || 0));
    }
    amount = Math.min(amount, remaining);
    remaining = Math.round((remaining - amount) * 100) / 100;
    amounts.set(line.position, amount);
  }
  return amounts;
}
