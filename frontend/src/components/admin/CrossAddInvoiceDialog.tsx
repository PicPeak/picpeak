/**
 * Cross-add dialog (issue #866, Feature 3).
 *
 * Shown when the admin bills ONE category (hours or re-bills) for a customer
 * who also has open items in the OTHER category. Offers to roll both into the
 * same invoice. Hours and re-bills are never merged into shared line items —
 * they stay as distinct, contiguous groups on the invoice.
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';

interface Props {
  open: boolean;
  /** The category the admin clicked "create invoice" on. */
  primary: 'hours' | 'rebills';
  /** How many OPEN items exist in the OTHER category. */
  otherCount: number;
  busy?: boolean;
  /** includeOther = true → combine both; false → bill only the primary. */
  onConfirm: (includeOther: boolean) => void;
  onClose: () => void;
}

export const CrossAddInvoiceDialog: React.FC<Props> = ({ open, primary, otherCount, busy, onConfirm, onClose }) => {
  const { t } = useTranslation();
  // Escape closes without billing (mirrors the explicit Cancel below).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);
  if (!open) return null;

  const other = primary === 'hours' ? 'rebills' : 'hours';
  const otherLabel = other === 'hours'
    ? t('crossAdd.hours', 'open hours')
    : t('crossAdd.rebills', 'open re-bills');
  const primaryOnlyLabel = primary === 'hours'
    ? t('crossAdd.hoursOnly', 'Just the hours')
    : t('crossAdd.rebillsOnly', 'Just the re-bills');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !busy && onClose()}>
      <div className="bg-shell rounded-lg shadow-xl w-full max-w-md mx-4 p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold mb-2 text-lg text-heading">
          {t('crossAdd.title', 'Add other open items?')}
        </h3>
        <p className="text-sm text-soft mb-4">
          {t('crossAdd.body',
            'This customer also has {{count}} {{label}}. Add them to the same invoice? They stay as a separate group — hours and re-bills are never mixed into one line.',
            { count: otherCount, label: otherLabel })}
        </p>
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <Button variant="outline" disabled={busy} onClick={() => onConfirm(false)}>{primaryOnlyLabel}</Button>
            <Button disabled={busy} onClick={() => onConfirm(true)}>{t('crossAdd.addBoth', 'Add both')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
};
