/**
 * Discount promotions on a quote (#1451): one checkbox per promotion that
 * applies today. Ticking one adds a discount line; unticking removes it.
 * The amount follows the subtotal (percentages first, then fixed amounts,
 * capped) — the line-items table shows it, the server resolves it on save.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tag } from 'lucide-react';
import type { EditableLineItem } from '../LineItemsTable';
import type { QuotePromotion } from '../../../services/quoteCatalog.service';
import { formatMoneyMinor } from '../../../utils/money';

interface Props {
  promotions: QuotePromotion[];
  items: EditableLineItem[];
  currency: string;
  onChange: (items: EditableLineItem[]) => void;
}

// Local calendar date — toISOString() would be UTC, a day off around midnight.
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Same rules the server applies: active, valid today, fixed ones in the quote's currency. */
function applicable(promotion: QuotePromotion, currency: string) {
  const today = todayIso();
  if (!promotion.isActive) return false;
  if (promotion.validFrom && today < promotion.validFrom) return false;
  if (promotion.validUntil && today > promotion.validUntil) return false;
  if (promotion.type === 'fixed' && promotion.currency && promotion.currency !== currency.toUpperCase()) return false;
  return true;
}

const promotionIdOf = (li: EditableLineItem) => li.promotionId ?? li.promotionSnapshot?.promotionId ?? null;

export const DiscountsPanel: React.FC<Props> = ({ promotions, items, currency, onChange }) => {
  const { t } = useTranslation();
  const offered = promotions.filter((p) => applicable(p, currency));
  const appliedIds = new Set(items.filter((li) => li.lineKind === 'discount').map(promotionIdOf));
  if (offered.length === 0 && appliedIds.size === 0) return null;

  const toggle = (promotion: QuotePromotion, on: boolean) => {
    if (!on) {
      onChange(items.filter((li) => !(li.lineKind === 'discount' && promotionIdOf(li) === promotion.id)));
      return;
    }
    const position = items.reduce((m, it) => Math.max(m, it.position), 0) + 1;
    onChange([...items, {
      position,
      quantity: 1,
      description: promotion.name,
      unitPrice: 0,
      discountPercent: 0,
      parentPosition: null,
      lineKind: 'discount',
      promotionId: promotion.id,
      // Local copy for the live preview; the server re-reads the promotion.
      promotionSnapshot: {
        promotionId: promotion.id,
        name: promotion.name,
        type: promotion.type,
        percent: promotion.percent ?? undefined,
        valueMinor: promotion.valueMinor ?? undefined,
        currency: promotion.currency,
      },
    }]);
  };

  const valueLabel = (p: QuotePromotion) => (p.type === 'percent'
    ? `−${p.percent} %`
    : `−${formatMoneyMinor(Number(p.valueMinor || 0), p.currency || currency)}`);

  return (
    <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">
        <Tag className="w-4 h-4" aria-hidden />
        {t('quotes.promotions.panelTitle', 'Discounts')}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {offered.map((p) => (
          <label key={p.id} className="inline-flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
            <input
              type="checkbox"
              checked={appliedIds.has(p.id)}
              onChange={(e) => toggle(p, e.target.checked)}
              className="rounded border-neutral-300"
            />
            <span>{p.name}</span>
            <span className="text-neutral-500 dark:text-neutral-400 tabular-nums">{valueLabel(p)}</span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        {t('quotes.promotions.panelHint', 'Percentages apply first, then fixed amounts — never more than the subtotal.')}
      </p>
    </div>
  );
};
