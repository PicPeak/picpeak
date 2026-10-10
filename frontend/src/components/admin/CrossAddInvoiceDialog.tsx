/**
 * Cross-add dialog (issue #866, Feature 3).
 *
 * Shown when the admin bills ONE category (hours or re-bills) for a customer
 * who also has open items in the OTHER category. Offers to roll both into the
 * same invoice. Hours and re-bills are never merged into shared line items —
 * they stay as distinct, contiguous groups on the invoice.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '../common';

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
  if (!open) return null;

  const other = primary === 'hours' ? 'rebills' : 'hours';
  const otherLabel = other === 'hours'
    ? t('crossAdd.hours', 'open hours')
    : t('crossAdd.rebills', 'open re-bills');
  const primaryOnlyLabel = primary === 'hours'
    ? t('crossAdd.hoursOnly', 'Just the hours')
    : t('crossAdd.rebillsOnly', 'Just the re-bills');

  return (
    // Escape, the close button and the backdrop close without billing
    // (mirrors the explicit Cancel below) — but not while it is billing.
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={t('crossAdd.title', 'Add other open items?')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose} className="sm:mr-auto">{t('common.cancel', 'Cancel')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => onConfirm(false)}>{primaryOnlyLabel}</Button>
          <Button disabled={busy} onClick={() => onConfirm(true)}>{t('crossAdd.addBoth', 'Add both')}</Button>
        </>
      }
    >
      <p className="text-sm text-soft">
        {t('crossAdd.body',
          'This customer also has {{count}} {{label}}. Add them to the same invoice? They stay as a separate group — hours and re-bills are never mixed into one line.',
          { count: otherCount, label: otherLabel })}
      </p>
    </Modal>
  );
};
