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
import { Loading } from '../../components/common';
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
  const [partialAmount, setPartialAmount] = useState<string>('');
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
    if (action === 'partial' && data && !partialAmount) {
      setPartialAmount((data.invoice.outstandingMinor / 100).toFixed(2));
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
        const v = Number(partialAmount);
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
    <div
      className="min-h-screen py-10 px-4"
      style={{
        backgroundColor: 'var(--color-background, #fafafa)',
        color: 'var(--color-text, #171717)',
      }}
    >
      <div className="max-w-2xl mx-auto">
        <BrandingHeader issuer={issuer} />
        <h1 className="text-2xl font-bold mb-1">{t('paymentCheck.title', 'Confirm payment')}</h1>
        <p className="text-sm mb-6" style={{ color: 'var(--color-muted-text, #737373)' }}>
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
                value={<span className="tabular-nums" style={{ color: 'var(--color-warning, #b45309)' }}>{formatMoney(inv.lateFeeMinor, inv.currency)}</span>}
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
            icon={<CheckCircle2 className="w-5 h-5" style={{ color: '#16a34a' }} />}
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
              icon={<CheckCircle2 className="w-5 h-5" style={{ color: '#0d9488' }} />}
              selected={action === 'paid_with_skonto'}
              onSelect={() => setAction('paid_with_skonto')}
            />
          )}
          <ActionCard
            label={t('paymentCheck.action.partial', 'Partially paid')}
            description={t('paymentCheck.action.partialHelp',
              'Log the amount received, then queue the customer reminder for the remainder.')}
            icon={<Wallet className="w-5 h-5" style={{ color: 'var(--color-accent, #2563eb)' }} />}
            selected={action === 'partial'}
            onSelect={() => setAction('partial')}
          >
            {action === 'partial' && (
              <div className="mt-3">
                <label className="block text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--color-muted-text)' }}>
                  {t('paymentCheck.action.partialAmount', 'Amount received')}
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{inv.currency}</span>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    max={inv.outstandingMinor / 100}
                    value={partialAmount}
                    onChange={(e) => setPartialAmount(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-md border text-sm"
                    style={{
                      backgroundColor: 'var(--color-elevated, #ffffff)',
                      borderColor: 'var(--color-surface-border, #e5e5e5)',
                      color: 'var(--color-text)',
                    }}
                  />
                </div>
                <p className="text-xs mt-1" style={{ color: 'var(--color-muted-text)' }}>
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
            icon={<AlertTriangle className="w-5 h-5" style={{ color: '#dc2626' }} />}
            selected={action === 'unpaid'}
            onSelect={() => setAction('unpaid')}
          />
        </div>

        {submitError && (
          <p className="mt-4 text-sm" style={{ color: '#dc2626' }}>{submitError}</p>
        )}

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!action || submitting}
            className="px-6 py-3 rounded-md font-medium disabled:opacity-50 transition-colors"
            style={{
              backgroundColor: 'var(--color-accent-dark, #2563eb)',
              color: 'var(--color-accent-fg, #ffffff)',
            }}
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
        <p className="text-sm" style={{ color: 'var(--color-muted-text, #737373)' }}>{issuer.website}</p>
      )}
    </header>
  );
};

const ThemedSurface: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
  <div
    className={`rounded-lg border ${className || ''}`}
    style={{
      backgroundColor: 'var(--color-surface, #ffffff)',
      borderColor: 'var(--color-surface-border, #e5e5e5)',
    }}
  >
    {children}
  </div>
);

const Field: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div>
    <div className="text-xs uppercase" style={{ color: 'var(--color-muted-text, #737373)' }}>{label}</div>
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
    className="w-full text-left rounded-lg border p-4 transition-colors"
    style={{
      borderColor: selected ? 'var(--color-accent, #2563eb)' : 'var(--color-surface-border, #e5e5e5)',
      backgroundColor: selected
        ? 'color-mix(in srgb, var(--color-accent) 8%, var(--color-surface))'
        : 'var(--color-surface, #ffffff)',
    }}
  >
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-sm mt-1" style={{ color: 'var(--color-muted-text, #737373)' }}>{description}</div>
        {children}
      </div>
    </div>
  </button>
);

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
  <div
    className="min-h-screen flex items-center justify-center p-6"
    style={{
      backgroundColor: 'var(--color-background, #fafafa)',
      color: 'var(--color-text)',
    }}
  >
    <div
      className="max-w-md w-full rounded-lg border p-6"
      style={{
        borderColor: '#fecaca',
        backgroundColor: 'color-mix(in srgb, #fee2e2 50%, var(--color-surface))',
      }}
    >
      <h1 className="text-lg font-bold mb-2" style={{ color: '#991b1b' }}>{message}</h1>
    </div>
  </div>
);

const ResultBox: React.FC<{
  result: { applied: PaymentCheckAction; reminderLevel?: number; reminderSkipped?: string };
  inv: PaymentCheckView;
  issuer: PaymentCheckIssuer | null;
}> = ({ result, inv, issuer }) => {
  const { t } = useTranslation();
  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{
        backgroundColor: 'var(--color-background, #fafafa)',
        color: 'var(--color-text)',
      }}
    >
      <div className="max-w-md w-full">
        <BrandingHeader issuer={issuer} />
        <div
          className="rounded-lg border p-6"
          style={{
            // Theme-adaptive success card — a light-green tint on light surfaces,
            // a dark-green tint on dark ones (was a hardcoded light-green mix +
            // dark-green title that went unreadable in dark mode, #759).
            borderColor: 'color-mix(in srgb, #16a34a 35%, var(--color-surface))',
            backgroundColor: 'color-mix(in srgb, #16a34a 12%, var(--color-surface))',
          }}
        >
          <CheckCircle2 className="w-10 h-10 mb-3" style={{ color: '#16a34a' }} />
          <h1 className="text-lg font-bold mb-1" style={{ color: 'var(--color-text)' }}>
            {t('paymentCheck.result.title', 'Action recorded')}
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-text)' }}>
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
          <p className="text-xs mt-4" style={{ color: 'var(--color-muted-text, #737373)' }}>
            {t('paymentCheck.result.close', 'You can close this tab.')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default PaymentCheckPage;
