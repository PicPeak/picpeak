/**
 * Reusable line-items editor for quotes + invoices.
 *
 * Two-level hierarchy (migration 119):
 *   - Top-level items roll into the document net/VAT/total.
 *   - Sub-items render indented under their parent. Their line total
 *     is shown in parentheses for transparency but is display-only;
 *     only the parent's price contributes to net.
 *   - Per-item `detailsText` is an optional free-form notes block
 *     rendered below the description on the PDF + customer view.
 *
 * Migration 215 (#1451) adds, per line:
 *   - a unit (hour / day / piece / km / flat) shown in the quantity cell;
 *   - quotes only: a price from the customer's or the default hour / day
 *     rate (resolved on save), a quantity that follows the quote-wide
 *     hours / days, and optional add-ons (an unselected one stays out of
 *     the totals);
 *   - discount lines (promotions), added by the editor's discount panel,
 *     whose amount follows the subtotal — percentages first, then fixed
 *     amounts, never more than the subtotal.
 * The server recomputes everything on save; the totals here mirror it via
 * utils/lineItemTotals.
 *
 * Items in `items` are kept in DISPLAY ORDER (parent immediately
 * followed by its sub-items, then the next parent, etc.). `position`
 * is a stable unique identifier used to link sub-items to parents in
 * the payload — once assigned at row creation we never renumber it.
 * Move up/down only swaps within the same level (top-level among
 * top-level, sub-items among siblings of the same parent).
 *
 * Money values are stored in MAJOR units in the form state (e.g. 250.00)
 * for editor ergonomics, then converted to minor (25000) when persisting.
 * The conversion happens at the save boundary in the parent page.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, ArrowUp, ArrowDown, Save as SaveIcon, ChevronDown, ChevronRight, CornerDownRight, Tag } from 'lucide-react';
import { Button } from '../common';
import { DecimalInput } from '../common/DecimalInput';
import { formatMoney } from '../../utils/money';
import {
  countedLines, isUnselectedOptional, resolveDiscountAmounts,
  type BoundTo, type LineKind, type LineUnit, type PriceMode, type PromotionSnapshot, type RateSource,
} from '../../utils/lineItemTotals';

export interface EditableLineItem {
  id?: number;
  /** Stable unique identifier used to link sub-items to parents. */
  position: number;
  quantity: number;
  description: string;
  /** Stored in major units (CHF / EUR) for UX. */
  unitPrice: number;
  discountPercent: number;
  /** NULL = top-level (rolls into net). Non-null = sub-item under that parent's position. */
  parentPosition?: number | null;
  /** Optional free-form notes rendered below the description. */
  detailsText?: string;
  // Migration 215 (#1451).
  lineKind?: LineKind;
  unit?: LineUnit | null;
  isOptional?: boolean;
  selected?: boolean;
  priceMode?: PriceMode | null;
  rateSource?: RateSource | null;
  boundTo?: BoundTo | null;
  promotionSnapshot?: PromotionSnapshot | null;
  /** Wire-only: a promotion ticked in the editor, resolved by the server on save. */
  promotionId?: number | null;
}

export interface LineItemPresetMinimal {
  id: number;
  name: string;
  description: string;
  unitPriceMinor: number;
  quantityDefault: number;
  unit?: LineUnit | null;
  detailsText?: string | null;
  priceMode?: PriceMode;
  pinnedRateMinor?: number | null;
}

/** A catalogue package the editor can insert as a parent line + its items. */
export interface PackageForInsert {
  id: number;
  name: string;
  description?: string | null;
  items: Array<{
    presetName?: string;
    detailsText?: string | null;
    quantity: number | null;
    boundTo?: BoundTo | null;
    unitPriceMinor?: number;
    unit?: LineUnit | null;
    priceMode?: PriceMode;
    pinnedRateMinor?: number | null;
    quantityDefault?: number;
  }>;
}

const UNITS: LineUnit[] = ['hour', 'day', 'piece', 'km', 'flat'];

interface Props {
  items: EditableLineItem[];
  currency: string;
  showDiscount?: boolean;
  vatRate?: number;
  shippingAmount?: number;
  /**
   * Sub-cent rounding reconciliation (crm_invoice_round_total). When true,
   * the net is the full-precision sum rounded once and the per-line
   * rounding drift is shown as a "Rundung" row — mirrors the backend
   * computeTotals + the PDF so the editor preview matches the saved
   * document. Off ⇒ net is the plain sum of rounded lines (unchanged).
   */
  roundTotal?: boolean;
  onChange: (items: EditableLineItem[]) => void;
  presets?: LineItemPresetMinimal[];
  onSaveAsPreset?: (item: EditableLineItem) => void;
  /** 'quote' enables optional add-ons and hour/day rates; invoices carry units only. */
  mode?: 'quote' | 'invoice';
  /** Quote-wide hours / days that bound lines follow (quotes only). */
  hours?: number | null;
  days?: number | null;
  /** Catalogue packages offered in the "Insert package" picker (quotes only). */
  packages?: PackageForInsert[];
}

function nextFreshPosition(items: EditableLineItem[]) {
  return items.reduce((m, it) => Math.max(m, it.position), 0) + 1;
}

function isSub(li: EditableLineItem) {
  return li.parentPosition != null;
}

const isDiscount = (li: EditableLineItem) => li.lineKind === 'discount';
const isRatePriced = (li: EditableLineItem) => li.priceMode === 'hour' || li.priceMode === 'day';
const usesRateChain = (li: EditableLineItem) => ['auto', 'customer', 'default'].includes(li.rateSource || '');

function blankLine(position: number, parentPosition: number | null = null): EditableLineItem {
  return {
    position,
    quantity: 1,
    description: '',
    unitPrice: 0,
    discountPercent: 0,
    parentPosition,
    detailsText: '',
    lineKind: 'item',
    unit: null,
    isOptional: false,
    selected: true,
  };
}

/**
 * A line from a catalogue item. Quotes take hour/day items from a rate: the
 * item's own pinned rate, or the customer's / default rate on save.
 */
function lineFromCatalogue(
  src: {
    name: string; unitPriceMinor?: number; unit?: LineUnit | null; priceMode?: PriceMode;
    pinnedRateMinor?: number | null; quantity: number; detailsText?: string | null; boundTo?: BoundTo | null;
  },
  position: number,
  parentPosition: number | null,
  mode: 'quote' | 'invoice',
): EditableLineItem {
  const rateBased = mode === 'quote' && (src.priceMode === 'hour' || src.priceMode === 'day');
  const pinned = src.pinnedRateMinor != null;
  return {
    ...blankLine(position, parentPosition),
    quantity: src.quantity,
    description: src.name,
    unitPrice: rateBased
      ? (pinned ? Number(src.pinnedRateMinor) / 100 : 0)
      : Number(src.unitPriceMinor || 0) / 100,
    detailsText: src.detailsText || '',
    unit: src.unit || (rateBased ? (src.priceMode as LineUnit) : null),
    priceMode: rateBased ? src.priceMode : null,
    rateSource: rateBased ? (pinned ? 'item' : 'auto') : null,
    boundTo: rateBased ? (src.boundTo || null) : null,
  };
}

export const LineItemsTable: React.FC<Props> = ({
  items, currency, showDiscount = true, vatRate = 0, shippingAmount = 0, roundTotal = false,
  onChange, presets = [], onSaveAsPreset, mode = 'invoice', hours = null, days = null, packages = [],
}) => {
  const { t } = useTranslation();
  const isQuote = mode === 'quote';

  // Track which rows have the details textarea expanded. Keyed by
  // `position` since that's stable across renders.
  const [detailsOpen, setDetailsOpen] = useState<Set<number>>(() => new Set(
    items.filter((it) => it.detailsText && it.detailsText.trim().length > 0).map((it) => it.position)
  ));
  const toggleDetails = (pos: number) => {
    setDetailsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(pos)) next.delete(pos); else next.add(pos);
      return next;
    });
  };

  const setItem = (idx: number, patch: Partial<EditableLineItem>) => {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    onChange(next);
  };

  const addRow = (preset?: LineItemPresetMinimal) => {
    const pos = nextFreshPosition(items);
    const row = preset
      ? {
        ...lineFromCatalogue({
          name: preset.name,
          unitPriceMinor: preset.unitPriceMinor,
          unit: preset.unit,
          priceMode: preset.priceMode,
          pinnedRateMinor: preset.pinnedRateMinor,
          quantity: Number(preset.quantityDefault) || 1,
          detailsText: preset.detailsText,
        }, pos, null, mode),
        description: `${preset.name}${preset.description ? `\n${preset.description}` : ''}`,
      }
      : blankLine(pos);
    onChange([...items, row]);
  };

  /**
   * Insert a catalogue package. One item: the package line carries the
   * price and the item is listed below it unpriced. Several items: each is
   * priced and the package line shows their sum (the auto-sum of priced
   * sub-items).
   */
  const insertPackage = (pkg: PackageForInsert) => {
    const parentPos = nextFreshPosition(items);
    const itemLines = pkg.items.map((it, i) => lineFromCatalogue({
      name: it.presetName || '',
      unitPriceMinor: it.unitPriceMinor,
      unit: it.unit,
      priceMode: it.priceMode,
      pinnedRateMinor: it.pinnedRateMinor,
      quantity: it.quantity ?? (Number(it.quantityDefault) || 1),
      detailsText: it.detailsText,
      boundTo: it.boundTo,
    }, parentPos + 1 + i, parentPos, mode));
    if (itemLines.length === 0) return;
    let rows: EditableLineItem[];
    if (itemLines.length === 1) {
      const [only] = itemLines;
      rows = [
        { ...only, position: parentPos, parentPosition: null, description: pkg.name, detailsText: pkg.description || '' },
        {
          ...blankLine(parentPos + 1, parentPos),
          description: only.description, quantity: only.quantity, unit: only.unit, boundTo: only.boundTo,
        },
      ];
    } else {
      rows = [{ ...blankLine(parentPos), description: pkg.name, detailsText: pkg.description || '' }, ...itemLines];
    }
    onChange([...items, ...rows]);
  };

  /**
   * Insert a fresh sub-item immediately AFTER the parent's last
   * existing sub-item (or the parent itself if there are none yet).
   * Keeps display order grouped: parent → its sub-items → next parent.
   */
  const addSubItem = (parentIdx: number) => {
    const parent = items[parentIdx];
    if (!parent || isSub(parent) || isDiscount(parent)) return; // 1 level deep; never under a discount
    let insertAt = parentIdx + 1;
    while (insertAt < items.length && items[insertAt].parentPosition === parent.position) {
      insertAt += 1;
    }
    const next = [...items];
    next.splice(insertAt, 0, blankLine(nextFreshPosition(items), parent.position));
    onChange(next);
  };

  /**
   * Remove a row. When removing a top-level parent, also sweep its
   * sub-items (CASCADE-equivalent in the editor, matches the DB FK
   * cascade so the editor's behaviour matches what would persist).
   */
  const removeRow = (idx: number) => {
    const target = items[idx];
    if (!target) return;
    if (!isSub(target)) {
      onChange(items.filter((it, i) => i !== idx && it.parentPosition !== target.position));
    } else {
      onChange(items.filter((_, i) => i !== idx));
    }
  };

  /**
   * Move up/down — restricted to siblings of the same level. For
   * top-level items, the entire "group" (parent + its sub-items) is
   * moved as a unit. For sub-items, the swap is within the same
   * parent's children only.
   */
  const move = (idx: number, dir: -1 | 1) => {
    const target = items[idx];
    if (!target) return;
    if (isSub(target)) {
      // Find sibling sub-items with same parent.
      const siblings: number[] = [];
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].parentPosition === target.parentPosition) siblings.push(i);
      }
      const here = siblings.indexOf(idx);
      const other = here + dir;
      if (other < 0 || other >= siblings.length) return;
      const next = [...items];
      [next[siblings[here]], next[siblings[other]]] = [next[siblings[other]], next[siblings[here]]];
      onChange(next);
    } else {
      // Move top-level group as a block. Find the range of this group
      // and the adjacent group's range, then swap them.
      const groupStart = idx;
      let groupEnd = idx + 1;
      while (groupEnd < items.length && items[groupEnd].parentPosition === target.position) {
        groupEnd += 1;
      }
      if (dir === -1) {
        if (groupStart === 0) return;
        // Find the previous top-level item's group range.
        let prevTopIdx = groupStart - 1;
        while (prevTopIdx > 0 && isSub(items[prevTopIdx])) prevTopIdx -= 1;
        const prevGroupStart = prevTopIdx;
        const prevGroupEnd = groupStart; // exclusive
        const before = items.slice(0, prevGroupStart);
        const prevGroup = items.slice(prevGroupStart, prevGroupEnd);
        const thisGroup = items.slice(groupStart, groupEnd);
        const after = items.slice(groupEnd);
        onChange([...before, ...thisGroup, ...prevGroup, ...after]);
      } else {
        if (groupEnd >= items.length) return;
        const nextTopIdx = groupEnd; // is a top-level by construction
        let nextGroupEnd = nextTopIdx + 1;
        while (nextGroupEnd < items.length && isSub(items[nextGroupEnd])) nextGroupEnd += 1;
        const before = items.slice(0, groupStart);
        const thisGroup = items.slice(groupStart, groupEnd);
        const nextGroup = items.slice(nextTopIdx, nextGroupEnd);
        const after = items.slice(nextGroupEnd);
        onChange([...before, ...nextGroup, ...thisGroup, ...after]);
      }
    }
  };

  /** Quantity actually used: a bound line follows the quote-wide hours / days. */
  const effectiveQuantity = (li: EditableLineItem) => {
    if (isQuote && li.boundTo === 'hours' && hours != null) return hours;
    if (isQuote && li.boundTo === 'days' && days != null) return days;
    return li.quantity;
  };

  const rawLineTotal = (li: EditableLineItem) =>
    Math.round(effectiveQuantity(li) * li.unitPrice * (1 - li.discountPercent / 100) * 100) / 100;

  /**
   * A parent has "priced sub-items" when at least one of its
   * children has unitPrice > 0. In that mode the parent's own
   * unit_price / qty / discount inputs are disabled and its line
   * total auto-resolves to the sum of those priced sub-items.
   * Matches the backend resolveParentTotalsFromSubItems() rule
   * (migration 119) so the editor mirrors what gets persisted.
   */
  // D.4 — memoize the per-parent child-pricing aggregates. The previous
  // shape rescanned `items` on every call, and the helpers were called
  // inside the JSX loop AND from the subtotal reduce — so on a 20-item
  // quote each keystroke ran ~O(n²) array scans. Build a Map once per
  // render and read O(1) afterwards.
  const childPricingByParent = useMemo(() => {
    const map = new Map<number, { hasPriced: boolean; pricedSum: number; pricedSumExact: number }>();
    for (const c of items) {
      if (c.parentPosition == null) continue;
      if (!(c.unitPrice > 0)) continue;
      const cur = map.get(c.parentPosition) || { hasPriced: false, pricedSum: 0, pricedSumExact: 0 };
      cur.hasPriced = true;
      cur.pricedSum += rawLineTotal(c);
      // Un-rounded contribution for the clean-net reconciliation below.
      cur.pricedSumExact += effectiveQuantity(c) * c.unitPrice * (1 - c.discountPercent / 100);
      map.set(c.parentPosition, cur);
    }
    return map;
    // rawLineTotal / effectiveQuantity are pure functions of the closure's
    // `items`, `hours` and `days`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hours, days]);
  const hasPricedChildren = (parentPos: number) =>
    childPricingByParent.get(parentPos)?.hasPriced || false;
  const pricedChildrenSum = (parentPos: number) =>
    childPricingByParent.get(parentPos)?.pricedSum || 0;

  /** Resolved total of a regular line: a parent auto-sums when sub-items are priced. */
  const itemTotal = (li: EditableLineItem) => {
    if (!isSub(li) && hasPricedChildren(li.position)) {
      return pricedChildrenSum(li.position);
    }
    return rawLineTotal(li);
  };

  // Totals follow the server: unselected add-ons don't count, discount
  // lines come off the regular subtotal (utils/lineItemTotals).
  const counted = countedLines(items);
  const regularTopLevel = counted.filter((li) => !isSub(li) && !isDiscount(li));
  const regularSubtotal = regularTopLevel.reduce((s, li) => s + itemTotal(li), 0);
  const discountAmounts = resolveDiscountAmounts(items, regularSubtotal);
  const discountTotal = [...discountAmounts.values()].reduce((s, v) => s + v, 0);

  /** What the total column shows for a line. */
  const lineTotal = (li: EditableLineItem) => (isDiscount(li) ? -(discountAmounts.get(li.position) || 0) : itemTotal(li));

  const subtotal = Math.round((regularSubtotal - discountTotal) * 100) / 100;

  // Sub-cent reconciliation (crm_invoice_round_total) — mirrors backend
  // utils/invoiceRounding.cleanNetMinor: sum each contributing row's
  // FULL-PRECISION product (parent with priced sub-items uses the
  // children) and round ONCE. The drift vs the sum-of-rounded-lines
  // `subtotal` is shown as a "Rundung" row and folded into the total, so
  // the editor preview matches the saved invoice + PDF.
  const cleanExact = regularTopLevel.reduce((s, li) => (
    hasPricedChildren(li.position)
      ? s + (childPricingByParent.get(li.position)?.pricedSumExact || 0)
      : s + effectiveQuantity(li) * li.unitPrice * (1 - li.discountPercent / 100)
  ), 0) - discountTotal;
  const cleanSubtotal = Math.round(cleanExact * 100) / 100;
  const roundingAdjustment = roundTotal ? Math.round((cleanSubtotal - subtotal) * 100) / 100 : 0;
  // Net the VAT + total work off: clean when reconciling, raw subtotal otherwise.
  const netForTotals = subtotal + roundingAdjustment;
  // vatRate is a FRACTION (0.081). Round to cents: round(net * vatRate * 100)
  // / 100 — the *100 inside round was missing, which divided the VAT by 100
  // (CHF 0.63 instead of 63.18). Backend computeTotals + the PDF were always
  // correct; only this live editor preview was wrong, and it only surfaced
  // once invoices stopped defaulting to 0% VAT.
  const vatAmount = Math.round(netForTotals * vatRate * 100) / 100;
  const total = netForTotals + vatAmount + (Number(shippingAmount) || 0);

  // Display numbering: top-level items get 1, 2, 3...; sub-items
  // render as N.1, N.2 under the parent for clarity. Discount lines
  // carry no number, like on the PDF.
  const displayNumbers = (() => {
    const out: string[] = [];
    let topCount = 0;
    let subCount = 0;
    for (const li of items) {
      if (isDiscount(li)) {
        out.push('');
      } else if (!isSub(li)) {
        topCount += 1;
        subCount = 0;
        out.push(String(topCount));
      } else {
        subCount += 1;
        out.push(`${topCount}.${subCount}`);
      }
    }
    return out;
  })();

  // Which top-level rows are excluded (unselected add-ons) — their
  // sub-items are greyed out too.
  const excludedPositions = new Set(items.filter((li) => !isSub(li) && isUnselectedOptional(li)).map((li) => li.position));

  const rateBadge = (li: EditableLineItem) => {
    switch (li.rateSource) {
      case 'customer': return t('crm.lineItems.rateSource.customer', 'Customer rate');
      case 'default': return t('crm.lineItems.rateSource.default', 'Default rate');
      case 'item': return t('crm.lineItems.rateSource.item', 'Item rate');
      case 'auto': return t('crm.lineItems.rateSource.auto', 'Rate applied on save');
      default: return null;
    }
  };

  const colCount = showDiscount ? 7 : 6;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
            <tr>
              <th className="px-2 py-2 text-left w-14">{t('crm.lineItems.position', 'Pos.')}</th>
              <th className="px-2 py-2 text-left w-20">{t('crm.lineItems.quantity', 'Anzahl')}</th>
              <th className="px-2 py-2 text-left">{t('crm.lineItems.description', 'Beschreibung')}</th>
              <th className="px-2 py-2 text-right w-28">{t('crm.lineItems.unitPrice', 'Einzelpreis')}</th>
              {showDiscount && (
                <th className="px-2 py-2 text-right w-24">{t('crm.lineItems.discount', 'Rabatt %')}</th>
              )}
              <th className="px-2 py-2 text-right w-28">{t('crm.lineItems.total', 'Summe')}</th>
              <th className="px-2 py-2 w-28"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((li, idx) => {
              const sub = isSub(li);
              const discountRow = isDiscount(li);
              const open = detailsOpen.has(li.position);
              const excluded = isUnselectedOptional(li) || (sub && excludedPositions.has(li.parentPosition as number));
              // Parent is "auto-totaled" when at least one of its
              // sub-items has a price. In that mode the qty / unit
              // price / discount inputs are disabled — the parent's
              // total is the sum of priced sub-items, computed by
              // the backend on save.
              const parentAutoTotaled = !sub && hasPricedChildren(li.position);
              const priceFromChain = isQuote && isRatePriced(li) && usesRateChain(li);
              const qtyBound = isQuote && !!li.boundTo;
              const disabledInputClass = 'bg-neutral-100 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 cursor-not-allowed';
              const enabledInputClass = 'bg-white dark:bg-neutral-800';
              const qtyDisabled = parentAutoTotaled || qtyBound;
              const priceDisabled = parentAutoTotaled || priceFromChain;
              const rowTone = excluded ? 'opacity-60' : '';

              if (discountRow) {
                return (
                  <tr key={li.position} className="border-t border-neutral-200 dark:border-neutral-700 bg-emerald-50/50 dark:bg-emerald-900/10">
                    <td className="px-2 py-2 align-top text-neutral-500 dark:text-neutral-400"><Tag className="w-3.5 h-3.5" aria-hidden /></td>
                    <td className="px-2 py-2 align-top"></td>
                    <td className="px-2 py-2 align-top text-neutral-800 dark:text-neutral-200">
                      <div className="font-medium">{li.description || li.promotionSnapshot?.name}</div>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {li.promotionSnapshot?.type === 'percent'
                          ? t('crm.lineItems.discountPercentHint', '{{percent}} % of the subtotal', { percent: li.promotionSnapshot.percent })
                          : t('crm.lineItems.discountLine', 'Discount')}
                      </div>
                    </td>
                    <td className="px-2 py-2"></td>
                    {showDiscount && <td className="px-2 py-2"></td>}
                    <td className="px-2 py-2 text-right tabular-nums align-top font-medium">
                      {formatMoney(lineTotal(li), currency)}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex items-center gap-1 justify-end">
                        <button type="button" onClick={() => removeRow(idx)} aria-label={t('crm.lineItems.remove', 'Remove') as string}
                          className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <React.Fragment key={li.position}>
                  <tr className={`border-t border-neutral-200 dark:border-neutral-700 ${
                    sub ? 'bg-neutral-50/60 dark:bg-neutral-900/40' : ''
                  } ${rowTone}`}>
                    <td className="px-2 py-2 text-neutral-600 dark:text-neutral-400 align-top">
                      <div className="flex items-center gap-1">
                        {sub && <CornerDownRight className="w-3.5 h-3.5 text-neutral-400" aria-hidden />}
                        <span>{displayNumbers[idx]}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 align-top">
                      <DecimalInput
                        className={`w-20 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm ${qtyDisabled ? disabledInputClass : enabledInputClass}`}
                        value={effectiveQuantity(li)}
                        onChange={(n) => setItem(idx, { quantity: Number.isFinite(n) ? n : 0 })}
                        disabled={qtyDisabled}
                        title={parentAutoTotaled
                          ? t('crm.lineItems.autoTotaledHint', 'Total auto-computed from sub-items below') as string
                          : qtyBound
                            ? t(li.boundTo === 'hours' ? 'crm.lineItems.followsHours' : 'crm.lineItems.followsDays',
                              li.boundTo === 'hours' ? 'Follows the quote hours' : 'Follows the quote days') as string
                            : undefined}
                      />
                      {li.unit && (
                        <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                          {t(`crm.lineItems.unitOption.${li.unit}`, li.unit)}
                        </div>
                      )}
                    </td>
                    <td className={`px-2 py-2 align-top ${sub ? 'pl-6' : ''}`}>
                      <textarea
                        rows={2}
                        className="w-full rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-sm"
                        value={li.description}
                        onChange={(e) => setItem(idx, { description: e.target.value })}
                        placeholder={t('crm.lineItems.descriptionPlaceholder', 'Description (multi-line OK)') as string}
                      />
                      {/* Migration 215 — unit, rate and add-on controls. */}
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
                        <label className="inline-flex items-center gap-1">
                          <span>{t('crm.lineItems.unitLabel', 'Unit')}</span>
                          <select
                            aria-label={t('crm.lineItems.unitLabel', 'Unit') as string}
                            value={li.unit || ''}
                            onChange={(e) => {
                              const unit = (e.target.value || null) as LineUnit | null;
                              const rateUnit = unit === 'hour' || unit === 'day';
                              setItem(idx, {
                                unit,
                                // A rate only applies to hour / day lines.
                                ...(rateUnit ? {} : { priceMode: null, boundTo: null, rateSource: li.rateSource === 'manual' ? null : li.rateSource && isRatePriced(li) ? null : li.rateSource }),
                                ...(rateUnit && isRatePriced(li) ? { priceMode: unit as PriceMode } : {}),
                              });
                            }}
                            className="rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-1 py-0.5"
                          >
                            <option value="">{t('crm.lineItems.unitNone', '—')}</option>
                            {UNITS.map((u) => (
                              <option key={u} value={u}>{t(`crm.lineItems.unitOption.${u}`, u)}</option>
                            ))}
                          </select>
                        </label>
                        {isQuote && (li.unit === 'hour' || li.unit === 'day') && (
                          <label className="inline-flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={isRatePriced(li) && li.rateSource !== 'manual'}
                              onChange={(e) => setItem(idx, e.target.checked
                                ? { priceMode: li.unit as PriceMode, rateSource: 'auto' }
                                : { priceMode: null, rateSource: 'manual', boundTo: li.boundTo })}
                            />
                            <span>{li.unit === 'hour'
                              ? t('crm.lineItems.useHourlyRate', 'Use hourly rate')
                              : t('crm.lineItems.useDayRate', 'Use day rate')}</span>
                          </label>
                        )}
                        {isQuote && (li.unit === 'hour' || li.unit === 'day') && (
                          <label className="inline-flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={!!li.boundTo}
                              onChange={(e) => setItem(idx, { boundTo: e.target.checked ? (li.unit === 'hour' ? 'hours' : 'days') : null })}
                            />
                            <span>{li.unit === 'hour'
                              ? t('crm.lineItems.followsHours', 'Follows the quote hours')
                              : t('crm.lineItems.followsDays', 'Follows the quote days')}</span>
                          </label>
                        )}
                        {isQuote && isRatePriced(li) && rateBadge(li) && (
                          <span className="rounded bg-neutral-100 dark:bg-neutral-700 px-1.5 py-0.5 text-[11px]">{rateBadge(li)}</span>
                        )}
                        {isQuote && !sub && (
                          <label className="inline-flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={!!li.isOptional}
                              onChange={(e) => setItem(idx, { isOptional: e.target.checked, selected: e.target.checked ? false : true })}
                            />
                            <span>{t('crm.lineItems.optional', 'Optional add-on')}</span>
                          </label>
                        )}
                        {isQuote && !sub && li.isOptional && (
                          <label className="inline-flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={li.selected !== false}
                              onChange={(e) => setItem(idx, { selected: e.target.checked })}
                            />
                            <span>{t('crm.lineItems.included', 'Included')}</span>
                          </label>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleDetails(li.position)}
                        className="mt-1 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                      >
                        {open
                          ? <ChevronDown className="w-3.5 h-3.5" aria-hidden />
                          : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
                        <span>
                          {(li.detailsText && li.detailsText.trim().length > 0)
                            ? t('crm.lineItems.detailsFilled', 'Details')
                            : t('crm.lineItems.detailsAdd', '+ Add details / notes')}
                        </span>
                      </button>
                      {open && (
                        <textarea
                          rows={2}
                          maxLength={2000}
                          className="mt-2 w-full rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-xs italic"
                          value={li.detailsText || ''}
                          onChange={(e) => setItem(idx, { detailsText: e.target.value })}
                          placeholder={t('crm.lineItems.detailsPlaceholder', 'Optional notes — fine print, package inclusions, conditions…') as string}
                        />
                      )}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <DecimalInput
                        className={`w-24 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm text-right ${priceDisabled ? disabledInputClass : enabledInputClass}`}
                        value={li.unitPrice}
                        fractionDigits={2}
                        onChange={(n) => setItem(idx, { unitPrice: Number.isFinite(n) ? n : 0 })}
                        disabled={priceDisabled}
                        title={parentAutoTotaled
                          ? t('crm.lineItems.autoTotaledHint', 'Total auto-computed from sub-items below') as string
                          : priceFromChain ? rateBadge(li) || undefined : undefined}
                      />
                    </td>
                    {showDiscount && (
                      <td className="px-2 py-2 align-top">
                        <DecimalInput
                          className={`w-20 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm text-right ${parentAutoTotaled ? disabledInputClass : enabledInputClass}`}
                          value={li.discountPercent}
                          onChange={(n) => {
                            // Clamp to 0..100 — match the original input's min/max.
                            const clamped = !Number.isFinite(n) ? 0 : Math.max(0, Math.min(100, n));
                            setItem(idx, { discountPercent: clamped });
                          }}
                          disabled={parentAutoTotaled}
                          title={parentAutoTotaled ? t('crm.lineItems.autoTotaledHint', 'Total auto-computed from sub-items below') as string : undefined}
                        />
                      </td>
                    )}
                    <td className={`px-2 py-2 text-right tabular-nums align-top ${
                      sub
                        ? 'text-neutral-500 dark:text-neutral-400 italic'
                        : 'font-medium'
                    }`}>
                      {sub
                        ? li.unitPrice > 0
                          ? `(${formatMoney(lineTotal(li), currency)})`
                          : ''
                        : formatMoney(lineTotal(li), currency)}
                      {parentAutoTotaled && (
                        <div className="text-[10px] font-normal text-neutral-500 dark:text-neutral-400 italic mt-0.5">
                          {t('crm.lineItems.autoTotaledNote', '= Σ Unterpositionen') as string}
                        </div>
                      )}
                      {!sub && excluded && (
                        <div className="text-[10px] font-normal text-neutral-500 dark:text-neutral-400 italic mt-0.5">
                          {t('crm.lineItems.notIncluded', 'not included')}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex items-center gap-1 justify-end flex-wrap">
                        <button type="button" onClick={() => move(idx, -1)} aria-label="Move up"
                          className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30">
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => move(idx, 1)} aria-label="Move down"
                          className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30">
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        {!sub && (
                          <button type="button" onClick={() => addSubItem(idx)} aria-label="Add sub-item"
                            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            title={t('crm.lineItems.addSubItem', 'Add sub-item') as string}>
                            <CornerDownRight className="w-4 h-4" />
                          </button>
                        )}
                        {onSaveAsPreset && !sub && (
                          <button type="button" onClick={() => onSaveAsPreset(li)} aria-label="Save as preset"
                            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            title={t('crm.lineItems.saveAsPreset', 'Save as preset') as string}>
                            <SaveIcon className="w-4 h-4" />
                          </button>
                        )}
                        <button type="button" onClick={() => removeRow(idx)} aria-label="Remove"
                          className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={colCount} className="px-2 py-6 text-center text-neutral-500 dark:text-neutral-400">
                {t('crm.lineItems.empty', 'No line items yet — add one to get started.')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => addRow()}>
          <Plus className="w-4 h-4 mr-1" />{t('crm.lineItems.addRow', 'Add row')}
        </Button>
        {presets.length > 0 && (
          <select
            aria-label={t('crm.lineItems.addFromPreset', 'Add from preset…') as string}
            className="text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-1.5"
            onChange={(e) => {
              const id = parseInt(e.target.value, 10);
              const preset = presets.find((p) => p.id === id);
              if (preset) addRow(preset);
              e.target.value = '';
            }}
            defaultValue=""
          >
            <option value="" disabled>{t('crm.lineItems.addFromPreset', 'Add from preset…')}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        {isQuote && packages.length > 0 && (
          <select
            aria-label={t('crm.lineItems.insertPackage', 'Insert package…') as string}
            className="text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-1.5"
            onChange={(e) => {
              const id = parseInt(e.target.value, 10);
              const pkg = packages.find((p) => p.id === id);
              if (pkg) insertPackage(pkg);
              e.target.value = '';
            }}
            defaultValue=""
          >
            <option value="" disabled>{t('crm.lineItems.insertPackage', 'Insert package…')}</option>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-col items-end gap-1 text-sm pt-2 border-t border-neutral-200 dark:border-neutral-700">
        <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('crm.lineItems.subtotal', 'Subtotal')}:</span><span className="tabular-nums w-28 text-right">{formatMoney(subtotal, currency)}</span></div>
        <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('crm.lineItems.vat', 'VAT')} ({(vatRate * 100).toFixed(1)}%):</span><span className="tabular-nums w-28 text-right">{formatMoney(vatAmount, currency)}</span></div>
        {!!shippingAmount && (
          <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('crm.lineItems.shipping', 'Shipping')}:</span><span className="tabular-nums w-28 text-right">{formatMoney(shippingAmount, currency)}</span></div>
        )}
        {roundingAdjustment !== 0 && (
          <div className="flex gap-6"><span className="text-neutral-600 dark:text-neutral-400">{t('crm.lineItems.rounding', 'Rounding')}:</span><span className="tabular-nums w-28 text-right">{formatMoney(roundingAdjustment, currency)}</span></div>
        )}
        <div className="flex gap-6 font-semibold text-base"><span>{t('crm.lineItems.total', 'Total')}:</span><span className="tabular-nums w-28 text-right">{formatMoney(total, currency)}</span></div>
      </div>
    </div>
  );
};

/** Map an API line item (minor units) to the editor's shape (major units). */
export function toEditableLineItem(li: {
  id?: number; position: number; quantity: number | string; description: string; unitPriceMinor?: number | null;
  discountPercent?: number | null; parentPosition?: number | null; detailsText?: string | null;
  lineKind?: LineKind; unit?: LineUnit | null; isOptional?: boolean; selected?: boolean;
  priceMode?: PriceMode | null; rateSource?: RateSource | null; boundTo?: BoundTo | null;
  promotionSnapshot?: PromotionSnapshot | null;
}): EditableLineItem {
  return {
    id: li.id,
    position: li.position,
    quantity: Number(li.quantity),
    description: li.description,
    unitPrice: Number(li.unitPriceMinor || 0) / 100,
    discountPercent: Number(li.discountPercent || 0),
    parentPosition: li.parentPosition ?? null,
    detailsText: li.detailsText || '',
    lineKind: li.lineKind || 'item',
    unit: li.unit ?? null,
    isOptional: !!li.isOptional,
    selected: li.selected !== false,
    priceMode: li.priceMode ?? null,
    rateSource: li.rateSource ?? null,
    boundTo: li.boundTo ?? null,
    promotionSnapshot: li.promotionSnapshot ?? null,
  };
}

/**
 * Editor line (major units) → API payload line (minor units). A discount
 * line picked in the editor (promotionId, no stored snapshot yet) sends
 * only the id so the server resolves and validates the promotion itself.
 */
export function toPayloadLineItem(li: EditableLineItem) {
  const freshPromotion = li.lineKind === 'discount' && li.promotionId && !li.id;
  return {
    position: li.position,
    quantity: li.quantity,
    description: li.description,
    unitPriceMinor: Math.round((Number(li.unitPrice) || 0) * 100),
    discountPercent: li.discountPercent,
    // Migration 119 — sub-items + details survive save → reload.
    parentPosition: li.parentPosition ?? null,
    detailsText: li.detailsText || null,
    lineKind: li.lineKind || 'item',
    unit: li.unit ?? null,
    isOptional: !!li.isOptional,
    selected: li.selected !== false,
    priceMode: li.priceMode ?? null,
    rateSource: li.rateSource ?? null,
    boundTo: li.boundTo ?? null,
    ...(freshPromotion
      ? { promotionId: li.promotionId }
      : { promotionSnapshot: li.promotionSnapshot ?? null }),
  };
}

// `formatMoney` is now the canonical helper from utils/money. Re-exported
// here so call-sites that historically imported from this file
// (CustomerCrmPanels, page-level summaries) keep working without churn.
export { formatMoney };
