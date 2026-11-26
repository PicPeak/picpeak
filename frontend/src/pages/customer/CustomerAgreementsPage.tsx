/**
 * Customer portal → Agreements (issue 2678).
 *
 * The briefs the photographer sent: the agreed details as of their last
 * update, read-only, with the date of that update. A project's brief also
 * shows the price from the accepted quote and the deposit invoice, which the
 * server includes only where this login may see quotes and invoices.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { Card, EmptyState, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../utils/money';
import { customerService, type CustomerAgreement } from '../../services/customer.service';
import { briefLabel, useBriefValueText } from '../../features/briefs/briefFields';
import { PortalLoadError } from './PortalListControls';

export const CustomerAgreementsPage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['customer-agreements'],
    queryFn: () => customerService.listAgreements(),
  });

  if (isLoading) return <Loading />;
  if (isError) {
    return (
      <PortalLoadError
        error={error}
        title={t('customer.agreements.title', 'Agreements')}
        disabledText={t('customer.agreements.disabled', 'There are no agreements for your account yet.')}
        loadErrorTitle={t('customer.agreements.loadError', 'Could not load your agreements.')}
        onRetry={() => { void refetch(); }}
        retrying={isFetching}
      />
    );
  }
  const agreements = data || [];

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme flex items-center gap-2">
          <ClipboardList className="w-6 h-6" />
          {t('customer.agreements.title', 'Agreements')}
        </h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('customer.agreements.subtitle', 'What you and your photographer agreed. If something is not right, please get in touch.')}
        </p>
      </div>
      {agreements.length === 0 ? (
        <Card padding="lg">
          <EmptyState size="inline" title={t('customer.agreements.empty', 'No agreements yet.')} />
        </Card>
      ) : (
        <div className="space-y-6">
          {agreements.map((agreement) => <Agreement key={agreement.id} agreement={agreement} />)}
        </div>
      )}
    </div>
  );
};

const Agreement: React.FC<{ agreement: CustomerAgreement }> = ({ agreement }) => {
  const { t, i18n } = useTranslation();
  const { format, formatDateTime } = useLocalizedDate();
  const valueText = useBriefValueText();
  const { price, deposit } = agreement;
  return (
    <Card padding="lg">
      <h2 className="text-lg font-semibold text-theme">{agreement.title || t('customer.agreements.untitled', 'Your booking')}</h2>
      <p className="text-xs text-muted-theme mb-4">
        {t('customer.agreements.updated', 'Updated on {{date}}', { date: formatDateTime(agreement.updatedAt) })}
      </p>
      {agreement.fields.length > 0 && (
        <dl className="grid grid-cols-1 sm:grid-cols-[minmax(0,14rem)_1fr] gap-x-6 gap-y-2 text-sm">
          {agreement.fields.map((field) => (
            <React.Fragment key={field.id}>
              <dt className="text-muted-theme">{briefLabel(field, i18n.language)}</dt>
              <dd className="text-theme whitespace-pre-line break-words">{valueText(field.type, field.value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {agreement.sharedArrangements && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-theme mb-1">{t('customer.agreements.shared', 'Arrangements')}</h3>
          <p className="text-sm text-theme whitespace-pre-line break-words">{agreement.sharedArrangements}</p>
        </div>
      )}
      {(price || deposit) && (
        <dl className="mt-4 pt-4 border-t border-border-token grid grid-cols-1 sm:grid-cols-[minmax(0,14rem)_1fr] gap-x-6 gap-y-2 text-sm">
          {price && (
            <>
              <dt className="text-muted-theme">{t('customer.agreements.price', 'Price')}</dt>
              <dd className="text-theme">
                {formatMoneyMinor(price.totalMinor, price.currency)}
                <span className="text-muted-theme"> · {t('customer.agreements.fromQuote', 'Quote {{number}}', { number: price.quoteNumber })}</span>
              </dd>
            </>
          )}
          {deposit && (
            <>
              <dt className="text-muted-theme">{t('customer.agreements.deposit', 'Deposit')}</dt>
              <dd className="text-theme">
                {formatMoneyMinor(deposit.totalMinor, deposit.currency)}
                {' · '}
                {deposit.paid ? (
                  <span className="status-chip hue-success">{t('customer.agreements.paid', 'Paid')}</span>
                ) : (
                  <span className="text-muted-theme">
                    {deposit.dueDate
                      ? t('customer.agreements.due', 'Due {{date}}', { date: format(deposit.dueDate) })
                      : t('customer.agreements.open', 'Open')}
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>
      )}
    </Card>
  );
};
