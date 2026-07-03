/**
 * VAT-rate picker for the invoice/quote editors. A dropdown whose ONLY options
 * are the configured OUTPUT VAT codes (Settings → Accounting) — there is no
 * free-text custom rate; to use a different rate, add a VAT code in Accounting.
 * Controlled by `(rate, code)`: selecting a code emits its rate + code string
 * (snapshotted on the document for the accounting export). Reads the un-gated
 * /admin/vat-codes endpoint so it works even when the accounting feature is off.
 *
 * Legacy preservation: when editing a document whose stored rate/code isn't an
 * accounting code anymore (an old invoice, or a deleted code), that value is
 * shown as a read-only "(not configured)" option so it stays selected and is
 * never silently changed — issued invoices are immutable. The admin can still
 * switch it to a current code.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { vatCodesService, type VatCodeOption } from '../../services/vatCodes.service';

const LEGACY = '__legacy__';
const selectCls =
  'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500';

interface Props {
  rate: number;
  code: string | null;
  onChange: (rate: number, code: string | null) => void;
  label?: string;
  disabled?: boolean;
}

export const VatRateSelect: React.FC<Props> = ({ rate, code, onChange, label, disabled }) => {
  const { t } = useTranslation();
  const { data: codes = [] } = useQuery({
    queryKey: ['vat-codes', 'output'],
    queryFn: () => vatCodesService.listOutput(),
    staleTime: 5 * 60 * 1000,
  });

  // Selected option: prefer the snapshotted code; else a code whose rate matches
  // (legacy rows / no code stored) — BUT only when that rate is unambiguous. If
  // two configured codes share the rate (e.g. two 8.1% codes), rate-matching
  // could silently swap one for the other on the next save, so fall through to
  // the legacy "(not configured)" option and make the admin pick explicitly
  // (PR #636 review #4).
  const matched: VatCodeOption | undefined =
    (code ? codes.find((c) => c.code === code) : undefined)
    || (!code && codes.filter((c) => Number(c.rate) === Number(rate)).length === 1
      ? codes.find((c) => Number(c.rate) === Number(rate)) : undefined);
  const showLegacy = !matched;

  return (
    <div>
      {label && (
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{label}</label>
      )}
      <select
        className={selectCls}
        disabled={disabled}
        value={matched ? String(matched.id) : LEGACY}
        onChange={(e) => {
          if (e.target.value === LEGACY) { onChange(rate, code); return; } // keep the legacy value
          const c = codes.find((x) => String(x.id) === e.target.value);
          if (c) onChange(Number(c.rate), c.code);
        }}
      >
        {showLegacy && (
          <option value={LEGACY}>
            {t('ledger.vat.legacyRate', '{{rate}}% (not configured)', { rate: Number(rate || 0).toFixed(1) })}
          </option>
        )}
        {codes.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name} ({Number(c.rate).toFixed(1)}%)
          </option>
        ))}
      </select>
    </div>
  );
};
