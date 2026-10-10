/**
 * Public payment-check landing page. Mounted at /payment-check/:token
 * (outside any auth gate). The admin arrives here from the email
 * button — the token in the URL is the only credential.
 *
 * Three actions:
 *   - Paid in full  → confirm, POST 'paid_full'
 *   - Partial       → enter amount, POST 'partial' with amountMinor
 *   - Not paid yet  → confirm, POST 'unpaid'
 *
 * Theming: respects the admin's branding settings — header carries
 * the logo + company name from Settings → Branding, surface/text
 * colors come from the theme CSS variables. Dark mode is applied
 * via the shared `usePublicDarkMode` hook.
 */
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Wallet, AlertTriangle } from 'lucide-react';
import {
  paymentCheckService,
  type PaymentCheckAction,
  type PaymentCheckView,
  type PaymentCheckIssuer,
} from '../../services/paymentCheck.service';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import { Loading, Notice } from '../../components/common';
import { DecimalInput } from '../../components/common/DecimalInput';
import { formatMoneyMinor } from '../../utils/money';
// All call-sites in this file pass minor units — alias to the
// minor-aware helper so the rest of the file is untouched.
const formatMoney = formatMoneyMinor;

import { formatShortDate } from '../../utils/dateShort';

export const PaymentCheckPage: React.FC = () => {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const initialAction = (searchParams.get('action') as PaymentCheckAction) || null;

  usePublicDarkMode();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['payment-check', token],
    queryFn: () => paymentCheckService.get(token!),
    enabled: !!token,
    retry: false,
  });

  const [action, setAction] = useState<PaymentCheckAction | null>(null);
  // NaN while the field is empty (DecimalInput accepts 12,50 and 12.50).
  const [partialAmount, setPartialAmount] = useState<number>(NaN);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ applied: PaymentCheckAction; reminderLevel?: number; reminderSkipped?: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!action && initialAction
      && ['paid_full', 'paid_with_skonto', 'partial', 'unpaid'].includes(initialAction)) {
      setAction(initialAction);
    }
  }, [initialAction, action]);

  useEffect(() => {
    if (action === 'partial' && data && Number.isNaN(partialAmount)) {
      setPartialAmount(data.invoice.outstandingMinor / 100);
    }
  }, [action, data, partialAmount]);

  if (!token) {
    return <ErrorBox message={t('paymentCheck.missingToken', 'Missing token')} />;
  }
  if (isLoading) return <Loading />;
  if (isError) {
    const status = (error as any)?.response?.status;
    const code = (error as any)?.response?.data?.code;
    if (status === 410 && code === 'TOKEN_ALREADY_USED') {
      const usedAction = (error as any)?.response?.data?.usedAction;
      return <ErrorBox message={t('paymentCheck.alreadyUsed',
        'This link has already been used (action: {{action}}). If you need to record another payment, open the invoice in admin.',
        { action: usedAction || '' })} />;
    }
    if (status === 410) {
      return <ErrorBox message={t('paymentCheck.expired',
        'This link has expired. Open the invoice in admin to record the payment manually.')} />;
    }
    return <ErrorBox message={t('paymentCheck.loadError', 'Could not load invoice. The link may be invalid.')} />;
  }
  const inv: PaymentCheckView = data!.invoice;
  const issuer: PaymentCheckIssuer | null = data!.issuer;

  if (result) return <ResultBox result={result} inv={inv} issuer={issuer} />;

  const submit = async () => {
    if (!action) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      let amountMinor: number | undefined;
      if (action === 'partial') {
        const v = partialAmount;
        if (!Number.isFinite(v) || v <= 0) {
          setSubmitError(t('paymentCheck.partialInvalid', 'Enter a positive amount.'));
          setSubmitting(false);
          return;
        }
        amountMinor = Math.round(v * 100);
        if (amountMinor > inv.outstandingMinor) {
          setSubmitError(t('paymentCheck.partialTooHigh',
            'Amount cannot exceed the outstanding total ({{max}}).',
            { max: formatMoney(inv.outstandingMinor, inv.currency) }));
          setSubmitting(false);
          return;
        }
      }
      const res = await paymentCheckService.record(token, { action, amountMinor });
      setResult(res);
    } catch (e: any) {
      setSubmitError(e?.response?.data?.error || t('paymentCheck.submitError', 'Could not record action.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen py-10 px-4 bg-background text-theme">
      <div className="max-w-2xl mx-auto">
        <BrandingHeader issuer={issuer} />
        <h1 className="text-2xl font-bold mb-1">{t('paymentCheck.title', 'Confirm payment')}</h1>
        <p className="text-sm mb-6 text-muted-theme">
          {t('paymentCheck.subtitle',
            'Select what was received for this invoice. The choice is logged and the appropriate reminder is queued automatically.')}
        </p>

        <ThemedSurface className="p-5 mb-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label={t('paymentCheck.field.invoice', 'Invoice')} value={<span className="font-mono">{inv.invoiceNumber}</span>} />
            <Field label={t('paymentCheck.field.customer', 'Customer')} value={inv.customer.label} />
            <Field label={t('paymentCheck.field.issued', 'Issued')} value={formatShortDate(inv.issueDate)} />
            <Field label={t('paymentCheck.field.due', 'Due')} value={formatShortDate(inv.dueDate)} />
            <Field label={t('paymentCheck.field.total', 'Total')} value={<span className="tabular-nums">{formatMoney(inv.totalMinor, inv.currency)}</span>} />
            <Field label={t('paymentCheck.field.outstanding', 'Outstanding')} value={<span className="tabular-nums font-semibold">{formatMoney(inv.outstandingMinor, inv.currency)}</span>} />
            {inv.paidMinor > 0 && (
              <Field label={t('paymentCheck.field.paid', 'Already paid')} value={<span className="tabular-nums">{formatMoney(inv.paidMinor, inv.currency)}</span>} />
            )}
            {inv.lateFeeMinor > 0 && (
              <Field
                label={t('paymentCheck.field.lateFee', 'Late fee')}
                value={<span className="tabular-nums text-warning-text">{formatMoney(inv.lateFeeMinor, inv.currency)}</span>}
              />
            )}
          </div>
        </ThemedSurface>

        <div className="space-y-3">
          <ActionCard
            label={t('paymentCheck.action.paidFull', 'Paid in full')}
            description={t('paymentCheck.action.paidFullHelp',
              'Mark the entire outstanding amount ({{amount}}) as received. No reminder is sent.',
              { amount: formatMoney(inv.outstandingMinor, inv.currency) })}
            icon={<CheckCircle2 className="w-5 h-5 text-success-text" />}
            selected={action === 'paid_full'}
            onSelect={() => setAction('paid_full')}
          />
          {/* Migration 126 — Skonto fast-path. Only rendered when the
              invoice's payment terms include a Skonto percentage; the
              backend resolves this and exposes hasSkonto + the
              discounted total so we don't have to recompute on the
              client. */}
          {inv.hasSkonto && inv.skontoDiscountedTotalMinor != null && (
            <ActionCard
              label={t('paymentCheck.action.paidSkonto', 'Paid with Skonto')}
              description={t('paymentCheck.action.paidSkontoHelp',
                'Customer settled within the Skonto window. Record {{amount}} ({{percent}}% discount) as paid.',
                {
                  amount: formatMoney(inv.skontoDiscountedTotalMinor, inv.currency),
                  percent: inv.skontoPercent,
                })}
              icon={<CheckCircle2 className="w-5 h-5 text-success-text" />}
              selected={action === 'paid_with_skonto'}
              onSelect={() => setAction('paid_with_skonto')}
            />
          )}
          <ActionCard
            label={t('paymentCheck.action.partial', 'Partially paid')}
            description={t('paymentCheck.action.partialHelp',
              'Log the amount received, then queue the customer reminder for the remainder.')}
            icon={<Wallet className="w-5 h-5 text-accent" />}
            selected={action === 'partial'}
            onSelect={() => setAction('partial')}
          >
            {action === 'partial' && (
              <div className="mt-3">
                <label htmlFor="payment-check-partial" className="block text-xs uppercase tracking-wider mb-1 text-muted-theme">
                  {t('paymentCheck.action.partialAmount', 'Amount received')}
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{inv.currency}</span>
                  <DecimalInput
                    id="payment-check-partial"
                    value={partialAmount}
                    onChange={setPartialAmount}
                    fractionDigits={2}
                    className="input-themed flex-1 min-w-0"
                  />
                </div>
                <p className="text-xs mt-1 text-muted-theme">
                  {t('paymentCheck.action.partialMax', 'Max: {{max}}', {
                    max: formatMoney(inv.outstandingMinor, inv.currency),
                  })}
                </p>
              </div>
            )}
          </ActionCard>
          <ActionCard
            label={t('paymentCheck.action.unpaid', 'Not paid yet')}
            description={t('paymentCheck.action.unpaidHelp',
              'Nothing received. The customer reminder will be queued{{fee}}.',
              { fee: inv.reminderLevel >= 1 ? t('paymentCheck.action.unpaidWithFee', ' (with late fee at second reminder)') : '' })}
            icon={<AlertTriangle className="w-5 h-5 text-danger-text" />}
            selected={action === 'unpaid'}
            onSelect={() => setAction('unpaid')}
          />
        </div>

        {submitError && (
          <p role="alert" className="mt-4 text-sm text-danger-text">{submitError}</p>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!action || submitting}
            className="px-6 py-3 rounded-md font-medium disabled:opacity-50 transition-colors bg-accent-strong text-accent-fg hover:opacity-90"
          >
            {submitting ? t('paymentCheck.submitting', 'Recording…') : t('paymentCheck.submit', 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

const BrandingHeader: React.FC<{ issuer: PaymentCheckIssuer | null }> = ({ issuer }) => {
  const { isDark } = usePublicDarkMode();
  if (!issuer || (!issuer.logoUrl && !issuer.logoUrlDark && !issuer.companyName)) return null;
  const logo = isDark
    ? (issuer.logoUrlDark || issuer.logoUrl)
    : (issuer.logoUrl || issuer.logoUrlDark);
  return (
    <header className="text-center mb-8">
      {logo && (
        <img
          src={logo}
          alt={issuer.companyName || 'Logo'}
          className="mx-auto h-16 w-auto object-contain mb-3"
        />
      )}
      {issuer.companyName && (
        <h2 className="text-xl font-bold">{issuer.companyName}</h2>
      )}
      {issuer.website && (
        <p className="text-sm text-muted-theme">{issuer.website}</p>
      )}
    </header>
  );
};

const ThemedSurface: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
  <div className={`rounded-lg border bg-surface border-border-token ${className || ''}`}>
    {children}
  </div>
);

const Field: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div>
    <div className="text-xs uppercase text-muted-theme">{label}</div>
    <div>{value}</div>
  </div>
);

interface ActionCardProps {
  label: string;
  description: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}
const ActionCard: React.FC<ActionCardProps> = ({ label, description, icon, selected, onSelect, children }) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className={`w-full text-left rounded-lg border p-4 transition-colors ${
      selected ? 'border-accent bg-accent-soft' : 'border-border-token bg-surface'
    }`}
  >
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-sm mt-1 text-muted-theme">{description}</div>
        {children}
      </div>
    </div>
  </button>
);

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
  <div className="min-h-screen flex items-center justify-center p-6 bg-background text-theme">
    <Notice tone="danger" className="max-w-md w-full">
      <h1 className="text-base font-semibold">{message}</h1>
    </Notice>
  </div>
);

const ResultBox: React.FC<{
  result: { applied: PaymentCheckAction; reminderLevel?: number; reminderSkipped?: string };
  inv: PaymentCheckView;
  issuer: PaymentCheckIssuer | null;
}> = ({ result, inv, issuer }) => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background text-theme">
      <div className="max-w-md w-full">
        <BrandingHeader issuer={issuer} />
        {/* The success tint over the operator's surface, readable on a light
            and a dark palette (#759); text stays the theme's own colour. */}
        <div className="rounded-lg border p-6 bg-success-soft border-success-line">
          <CheckCircle2 className="w-10 h-10 mb-3 text-success-text" />
          <h1 className="text-lg font-bold mb-1 text-theme">
            {t('paymentCheck.result.title', 'Action recorded')}
          </h1>
          <p className="text-sm text-theme">
            {result.applied === 'paid_full' && t('paymentCheck.result.paid',
              'Invoice {{n}} marked as paid in full.', { n: inv.invoiceNumber })}
            {result.applied === 'paid_with_skonto' && t('paymentCheck.result.paidSkonto',
              'Invoice {{n}} marked as paid with Skonto applied.', { n: inv.invoiceNumber })}
            {result.applied === 'partial' && t('paymentCheck.result.partial',
              'Partial payment logged for invoice {{n}}. Customer reminder queued for the remainder.',
              { n: inv.invoiceNumber })}
            {result.applied === 'unpaid' && result.reminderSkipped === 'max_level_reached'
              && t('paymentCheck.result.unpaidMax',
                'Recorded as unpaid. Maximum reminder level already reached — handle this customer offline.')}
            {result.applied === 'unpaid' && !result.reminderSkipped
              && t('paymentCheck.result.unpaid',
                'Recorded as unpaid. Customer reminder queued (level {{lvl}}).',
                { lvl: result.reminderLevel || 1 })}
          </p>
          <p className="text-xs mt-4 text-muted-theme">
            {t('paymentCheck.result.close', 'You can close this tab.')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default PaymentCheckPage;
