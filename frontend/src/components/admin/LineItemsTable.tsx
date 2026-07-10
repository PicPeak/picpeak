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
import { Plus, X, ArrowUp, ArrowDown, Save as SaveIcon, ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react';
import { Button } from '../common';
import { DecimalInput } from '../common/DecimalInput';
import { formatMoney } from '../../utils/money';

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
}

export interface LineItemPresetMinimal {
  id: number;
  name: string;
  description: string;
  unitPriceMinor: number;
  quantityDefault: number;
}

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
}

function nextFreshPosition(items: EditableLineItem[]) {
  return items.reduce((m, it) => Math.max(m, it.position), 0) + 1;
}

function isSub(li: EditableLineItem) {
  return li.parentPosition != null;
}

export const LineItemsTable: React.FC<Props> = ({
  items, currency, showDiscount = true, vatRate = 0, shippingAmount = 0, roundTotal = false,
  onChange, presets = [], onSaveAsPreset,
}) => {
  const { t } = useTranslation();

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
    const next = [...items, {
      position: pos,
      quantity: preset ? Number(preset.quantityDefault) || 1 : 1,
      description: preset ? `${preset.name}${preset.description ? `\n${preset.description}` : ''}` : '',
      unitPrice: preset ? Number(preset.unitPriceMinor) / 100 : 0,
      discountPercent: 0,
      parentPosition: null,
      detailsText: '',
    }];
    onChange(next);
  };

  /**
   * Insert a fresh sub-item immediately AFTER the parent's last
   * existing sub-item (or the parent itself if there are none yet).
   * Keeps display order grouped: parent → its sub-items → next parent.
   */
  const addSubItem = (parentIdx: number) => {
    const parent = items[parentIdx];
    if (!parent || isSub(parent)) return; // can't nest under a sub-item (1 level deep)
    let insertAt = parentIdx + 1;
    while (insertAt < items.length && items[insertAt].parentPosition === parent.position) {
      insertAt += 1;
    }
    const newRow: EditableLineItem = {
      position: nextFreshPosition(items),
      quantity: 1,
      description: '',
      unitPrice: 0,
      discountPercent: 0,
      parentPosition: parent.position,
      detailsText: '',
    };
    const next = [...items];
    next.splice(insertAt, 0, newRow);
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

  const rawLineTotal = (li: EditableLineItem) =>
    Math.round(li.quantity * li.unitPrice * (1 - li.discountPercent / 100) * 100) / 100;

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
      cur.pricedSumExact += c.quantity * c.unitPrice * (1 - c.discountPercent / 100);
      map.set(c.parentPosition, cur);
    }
    return map;
    // rawLineTotal is a pure function of the closure's `items`; the
    // dependency array gets the items snapshot directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const hasPricedChildren = (parentPos: number) =>
    childPricingByParent.get(parentPos)?.hasPriced || false;
  const pricedChildrenSum = (parentPos: number) =>
    childPricingByParent.get(parentPos)?.pricedSum || 0;

  /** Resolved line total: parent auto-sums when sub-items are priced. */
  const lineTotal = (li: EditableLineItem) => {
    if (!isSub(li) && hasPricedChildren(li.position)) {
      return pricedChildrenSum(li.position);
    }
    return rawLineTotal(li);
  };

  // Subtotal: top-level items ONLY (their resolved totals). Sub-items
  // never roll directly into net — they only feed their parent's
  // auto-resolved line total.
  const subtotal = items.filter((li) => !isSub(li)).reduce((s, li) => s + lineTotal(li), 0);

  // Sub-cent reconciliation (crm_invoice_round_total) — mirrors backend
  // utils/invoiceRounding.cleanNetMinor: sum each contributing row's
  // FULL-PRECISION product (parent with priced sub-items uses the
  // children) and round ONCE. The drift vs the sum-of-rounded-lines
  // `subtotal` is shown as a "Rundung" row and folded into the total, so
  // the editor preview matches the saved invoice + PDF.
  const cleanExact = items
    .filter((li) => !isSub(li))
    .reduce((s, li) => (
      hasPricedChildren(li.position)
        ? s + (childPricingByParent.get(li.position)?.pricedSumExact || 0)
        : s + li.quantity * li.unitPrice * (1 - li.discountPercent / 100)
    ), 0);
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
  // render as N.1, N.2 under the parent for clarity.
  const displayNumbers = (() => {
    const out: string[] = [];
    let topCount = 0;
    let subCount = 0;
    for (const li of items) {
      if (!isSub(li)) {
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
              const open = detailsOpen.has(li.position);
              // Parent is "auto-totaled" when at least one of its
              // sub-items has a price. In that mode the qty / unit
              // price / discount inputs are disabled — the parent's
              // total is the sum of priced sub-items, computed by
              // the backend on save.
              const parentAutoTotaled = !sub && hasPricedChildren(li.position);
              const disabledInputClass = parentAutoTotaled
                ? 'bg-neutral-100 dark:bg-neutral-700 text-neutral-400 cursor-not-allowed'
                : 'bg-white dark:bg-neutral-800';
              return (
                <React.Fragment key={li.position}>
                  <tr className={`border-t border-neutral-200 dark:border-neutral-700 ${
                    sub ? 'bg-neutral-50/60 dark:bg-neutral-900/40' : ''
                  }`}>
                    <td className="px-2 py-2 text-neutral-600 dark:text-neutral-400 align-top">
                      <div className="flex items-center gap-1">
                        {sub && <CornerDownRight className="w-3.5 h-3.5 text-neutral-400" aria-hidden />}
                        <span>{displayNumbers[idx]}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 align-top">
                      <DecimalInput
                        className={`w-20 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm ${disabledInputClass}`}
                        value={li.quantity}
                        onChange={(n) => setItem(idx, { quantity: Number.isFinite(n) ? n : 0 })}
                        disabled={parentAutoTotaled}
                        title={parentAutoTotaled ? t('crm.lineItems.autoTotaledHint', 'Total auto-computed from sub-items below') as string : undefined}
                      />
                    </td>
                    <td className={`px-2 py-2 align-top ${sub ? 'pl-6' : ''}`}>
                      <textarea
                        rows={2}
                        className="w-full rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-sm"
                        value={li.description}
                        onChange={(e) => setItem(idx, { description: e.target.value })}
                        placeholder={t('crm.lineItems.descriptionPlaceholder', 'Description (multi-line OK)') as string}
                      />
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
                        className={`w-24 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm text-right ${disabledInputClass}`}
                        value={li.unitPrice}
                        fractionDigits={2}
                        onChange={(n) => setItem(idx, { unitPrice: Number.isFinite(n) ? n : 0 })}
                        disabled={parentAutoTotaled}
                        title={parentAutoTotaled ? t('crm.lineItems.autoTotaledHint', 'Total auto-computed from sub-items below') as string : undefined}
                      />
                    </td>
                    {showDiscount && (
                      <td className="px-2 py-2 align-top">
                        <DecimalInput
                          className={`w-20 rounded border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm text-right ${disabledInputClass}`}
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
              <tr><td colSpan={showDiscount ? 7 : 6} className="px-2 py-6 text-center text-neutral-500">
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

// `formatMoney` is now the canonical helper from utils/money. Re-exported
// here so call-sites that historically imported from this file
// (CustomerCrmPanels, page-level summaries) keep working without churn.
export { formatMoney };
