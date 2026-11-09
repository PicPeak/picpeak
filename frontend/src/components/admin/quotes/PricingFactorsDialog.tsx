/**
 * Quote editor → price a catalogue service with its pricing factors (#2440).
 * The admin fills in the values; the server prices them (the same function
 * the public booking estimate uses) and the dialog shows the breakdown live.
 * "Apply" hands the result back: the editor turns it into a parent line plus
 * one priced sub-line per factor.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '../../common';
import { FactorInputs, initialFactorValue } from '../../../features/pricing-factors/FactorInputs';
import type { FactorPriceResult, FactorValue, PricingFactor } from '../../../services/quoteCatalog.service';
import { formatMoneyMinor } from '../../../utils/money';

interface Props {
  open: boolean;
  title: string;
  currency: string;
  factors: PricingFactor[];
  /** Values to start from (re-editing a line); otherwise each factor's default. */
  initialValues?: Record<string, FactorValue> | null;
  price: (values: Record<string, FactorValue>) => Promise<FactorPriceResult>;
  onApply: (result: FactorPriceResult) => void;
  onClose: () => void;
}

const errorText = (err: any): string => err?.response?.data?.error || err?.message || 'Failed';

export const PricingFactorsDialog: React.FC<Props> = ({
  open, title, currency, factors, initialValues, price, onApply, onClose,
}) => {
  const { t } = useTranslation();
  const startValues = useMemo(() => {
    const out: Record<string, FactorValue> = {};
    for (const f of factors) out[f.id] = initialValues && f.id in initialValues ? initialValues[f.id] : initialFactorValue(f);
    return out;
  }, [factors, initialValues]);
  const [values, setValues] = useState(startValues);
  const [result, setResult] = useState<FactorPriceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setValues(startValues); }, [open, startValues]);

  // Re-price shortly after the last change.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const next = await price(values);
        if (!cancelled) { setResult(next); setError(null); }
      } catch (err) {
        if (!cancelled) { setResult(null); setError(errorText(err)); }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, values, price]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={false}
      size="lg"
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => result && onApply(result)} disabled={!result || busy}>
            {t('quotes.factors.apply', 'Apply to quote')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <FactorInputs factors={factors} values={values} onChange={setValues} zoneMode="pick"
          unmatched={result?.unmatched} idPrefix="quote-factor" />
        <div>
          <div className="text-sm font-medium text-body mb-2">{t('quotes.factors.breakdown', 'Price')}</div>
          {error && <p className="text-sm text-danger-text">{error}</p>}
          {result && (
            <table className="w-full text-sm" aria-busy={busy}>
              <tbody>
                {result.lines.map((l, i) => (
                  <tr key={i} className="border-b border-line-faint">
                    <td className="py-1.5 pr-2 text-body">{l.description}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatMoneyMinor(l.totalMinor, result.currency || currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="pt-2 font-semibold">{t('crm.lineItems.total', 'Total')}</td>
                  <td className="pt-2 text-right tabular-nums font-semibold">{formatMoneyMinor(result.totalMinor, result.currency || currency)}</td>
                </tr>
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-muted">
            {t('quotes.factors.dialogHint', 'Each factor becomes its own line under the service. You can still edit the lines afterwards.')}
          </p>
        </div>
      </div>
    </Modal>
  );
};
