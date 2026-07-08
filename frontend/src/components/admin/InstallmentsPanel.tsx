/**
 * <InstallmentsPanel> — shared editor surface for the per-document
 * installment plan. Used by both QuoteEditorPage and BillEditorPage.
 *
 * Two render modes:
 *   - Simple (default): per-row date picker mapped to trigger='fixed_date'
 *   - Advanced (toggle): per-row trigger dropdown + offset_days
 *
 * Rows store the canonical {label, percent, trigger, offset_days}
 * shape (PaymentTermInstallment from quotes.service.ts). Date pickers
 * are a UX convenience layered over `trigger='fixed_date' + offset_days`.
 *
 * When the panel is "off" (`value: null`), the document is treated as
 * a single-invoice / single-payment plan and the parent editor skips
 * the installment field on save. Switching the panel on inserts a
 * default 100% row pre-populated from `useInstallmentDefaults()`.
 *
 * Validation: percents must sum to 100 (rendered inline below the
 * footer; parent uses `onValidityChange` to disable Save when wrong).
 *
 * The parent owns the `value` state; this component is fully
 * controlled. Render is React-Strict-Mode safe (no state in refs that
 * outlives the props).
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus } from 'lucide-react';
import { Button, Input, LocalizedDateInput } from '../common';
import type { PaymentTermInstallment } from '../../services/quotes.service';
import { useInstallmentDefaults } from '../../hooks/useInstallmentDefaults';

export type InstallmentPlan = PaymentTermInstallment[];

export interface InstallmentsPanelProps {
  /** null = single-document mode (no installments). Array = the plan. */
  value: InstallmentPlan | null;
  onChange: (next: InstallmentPlan | null) => void;
  /** Reports whether percents sum to 100. Parent uses to gate Save. */
  onValidityChange?: (valid: boolean) => void;
  /** Event date used for trigger preview text in advanced mode. */
  eventDate?: string | null;
  /** Disable inputs (e.g. document is locked / sent). */
  disabled?: boolean;
}

const ALL_TRIGGERS: PaymentTermInstallment['trigger'][] = [
  'quote_accepted', 'before_event', 'after_event', 'after_delivery', 'fixed_date',
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(base: string, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const f = new Date(from);
  const t = new Date(to);
  return Math.round((t.getTime() - f.getTime()) / 86_400_000);
}

export const InstallmentsPanel: React.FC<InstallmentsPanelProps> = ({
  value, onChange, onValidityChange, eventDate, disabled,
}) => {
  const { t } = useTranslation();
  const defaults = useInstallmentDefaults();
  const [advanced, setAdvanced] = React.useState(false);

  const enabled = value !== null;
  const rows = value || [];

  const totalPercent = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.percent) || 0), 0),
    [rows],
  );
  const isValid = !enabled || Math.abs(totalPercent - 100) < 0.001;
  React.useEffect(() => {
    onValidityChange?.(isValid);
  }, [isValid, onValidityChange]);

  const update = (idx: number, patch: Partial<PaymentTermInstallment>) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange(next);
  };

  const remove = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    onChange(next.length === 0 ? null : next);
  };

  const addRow = () => {
    // Default-shape new row: use the admin's defaults via a positional
    // heuristic — first row inherits the "first installment" trigger,
    // middle rows default to before_event, last row inherits after_event.
    let trigger: PaymentTermInstallment['trigger'] = defaults.triggerFirst;
    let offsetDays = 0;
    if (rows.length === 0) {
      trigger = defaults.triggerFirst;
      offsetDays = 0;
    } else {
      // Second row onwards. If there's already a row tagged after_event,
      // a new one slots in as before_event; else default to after_event.
      const hasAfterEvent = rows.some((r) => r.trigger === 'after_event');
      trigger = hasAfterEvent ? 'before_event' : 'after_event';
      offsetDays = hasAfterEvent ? -defaults.daysBeforeEvent : defaults.daysAfterEvent;
    }
    // Suggest a percent that fills the gap (clamped to 0-100).
    const gap = Math.max(0, 100 - totalPercent);
    const next: PaymentTermInstallment = {
      label: '',
      percent: gap > 0 ? gap : 0,
      trigger,
      offset_days: offsetDays,
    };
    onChange([...rows, next]);
  };

  const toggleEnabled = () => {
    if (enabled) {
      onChange(null);
      return;
    }
    // Switch on: seed with one 100% row using the "first installment"
    // default trigger so the panel doesn't open with an empty list.
    onChange([{
      label: t('installments.firstRowDefaultLabel', 'Anzahlung') as string,
      percent: 100,
      trigger: defaults.triggerFirst,
      offset_days: 0,
    }]);
  };

  // Map a row to its "Send on" date in simple mode. Only meaningful
  // when trigger is fixed_date; for dynamic triggers we display the
  // resolved date if we have eventDate, else show a placeholder.
  const previewDate = (row: PaymentTermInstallment): string | null => {
    const baseline = todayIso();
    if (row.trigger === 'fixed_date' || row.trigger === 'quote_accepted') {
      return addDays(baseline, row.offset_days || 0);
    }
    if ((row.trigger === 'before_event' || row.trigger === 'after_event') && eventDate) {
      return addDays(eventDate, row.offset_days || 0);
    }
    return null;
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={toggleEnabled}
            disabled={disabled}
          />
          {t('installments.enableLabel', 'Split into installments')}
        </label>
        {enabled && (
          <button
            type="button"
            className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
            onClick={() => setAdvanced((v) => !v)}
            disabled={disabled}
          >
            {advanced
              ? t('installments.simpleToggle', 'Use simple date picker')
              : t('installments.advancedToggle', 'Use dynamic triggers')}
          </button>
        )}
      </div>

      {enabled && (
        <>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            {advanced
              ? t('installments.advancedHint',
                'Pick a trigger (quote accepted, before/after event, on delivery, fixed date) plus offset in days. Triggers re-resolve if the event date later shifts.')
              : t('installments.simpleHint',
                'Each row fires on a specific date. Switch to dynamic triggers for plans tied to event date or delivery.')}
          </p>

          <div className="space-y-2">
            {rows.map((row, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 items-end p-2 rounded-md bg-neutral-50 dark:bg-neutral-800/40"
              >
                <div className="col-span-2">
                  <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
                    {t('installments.percent', '%')}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={row.percent}
                    onChange={(e) => update(idx, { percent: Number(e.target.value) })}
                    disabled={disabled}
                  />
                </div>
                <div className="col-span-4">
                  <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
                    {t('installments.label', 'Label')}
                  </label>
                  <Input
                    value={row.label}
                    onChange={(e) => update(idx, { label: e.target.value })}
                    disabled={disabled}
                    placeholder={t('installments.labelPlaceholder', 'Anzahlung / vor Event …') as string}
                  />
                </div>

                {!advanced ? (
                  <div className="col-span-5">
                    <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
                      {t('installments.sendOn', 'Send on')}
                    </label>
                    {row.trigger === 'after_delivery' ? (
                      <div className="text-xs text-neutral-500 dark:text-neutral-400 py-2">
                        {t('installments.onDeliveryHint',
                          'On delivery — admin releases manually. Switch to advanced to change.')}
                      </div>
                    ) : (
                      <LocalizedDateInput
                        value={previewDate(row) || ''}
                        onChange={(next) => {
                          if (!next) return;
                          const offset = daysBetween(todayIso(), next);
                          update(idx, { trigger: 'fixed_date', offset_days: offset });
                        }}
                        disabled={disabled}
                      />
                    )}
                  </div>
                ) : (
                  <>
                    <div className="col-span-3">
                      <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
                        {t('installments.trigger', 'Trigger')}
                      </label>
                      <select
                        value={row.trigger}
                        onChange={(e) => update(idx, {
                          trigger: e.target.value as PaymentTermInstallment['trigger'],
                          offset_days: e.target.value === 'after_delivery' ? 0 : row.offset_days,
                        })}
                        disabled={disabled}
                        className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                      >
                        {ALL_TRIGGERS.map((tr) => (
                          <option key={tr} value={tr}>
                            {t(`installments.triggerOption.${tr}`, tr)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
                        {t('installments.offsetDays', 'Offset (days)')}
                      </label>
                      <Input
                        type="number"
                        value={row.offset_days}
                        onChange={(e) => update(idx, { offset_days: Number(e.target.value) })}
                        disabled={disabled || row.trigger === 'after_delivery'}
                      />
                    </div>
                  </>
                )}

                <div className="col-span-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    disabled={disabled}
                    className="p-2 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-red-600"
                    aria-label={t('installments.removeRow', 'Remove row') as string}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between mt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addRow}
              disabled={disabled || totalPercent >= 100}
              leftIcon={<Plus className="w-4 h-4" />}
            >
              {t('installments.addRow', 'Add installment')}
            </Button>
            <div className={`text-sm font-medium ${isValid ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
              {t('installments.total', 'Total')}: {totalPercent.toFixed(2)}%
              {!isValid && ` — ${t('installments.mustSumTo100', 'must sum to 100%')}`}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default InstallmentsPanel;
