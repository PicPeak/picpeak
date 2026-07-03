/**
 * /admin/clients/hours — standalone time-logging surface.
 *
 * Lives below the Invoices sub-nav entry, gated by the `hoursLogging`
 * master feature flag. Admin picks any customer that has the
 * per-customer `feature_hours_logging` toggle on, then logs entries
 * via the shared HoursSection component. For monthly-mode customers
 * entries auto-append to the running monthly draft; for per-event
 * customers a "Bill these hours" button mints a standalone invoice
 * (both behaviours live inside HoursSection — this page is just the
 * customer picker on top).
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Clock, ChevronRight, AlertTriangle } from 'lucide-react';
import { Card } from '../../../components/common';
import { HoursSection } from '../../../components/admin/HoursSection';
import {
  CustomerPicker,
  type CustomerSummary,
} from '../../../components/admin/CustomerPicker';
import {
  customerAdminService,
  type CustomerAccountDetail,
  type UnbilledHoursSummaryRow,
} from '../../../services/customerAdmin.service';
import { businessProfileService } from '../../../services/businessProfile.service';
import { formatMoneyMinor } from '../../../utils/money';

/** Build a display label matching the CustomerPicker convention. */
function summaryLabel(r: UnbilledHoursSummaryRow): string {
  return (
    r.companyName
    || [r.firstName, r.lastName].filter(Boolean).join(' ')
    || r.displayName
    || r.email
    || `#${r.customerAccountId}`
  );
}

export const HoursLoggingPage: React.FC = () => {
  const { t } = useTranslation();

  // Picker state mirrors the contract from CustomerPicker — parent owns
  // the id + display label + passive flag triple. This makes the page
  // consistent with the Quote / Bill / Contract editors (#9) instead of
  // the old plain <select> that scrolled through ALL customers.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerIsPassive, setCustomerIsPassive] = useState(false);
  // Tracks the picked customer's hour-logging eligibility so the
  // HoursSection only renders for eligible customers (matches the
  // calendar drag-create modal's guard).
  const [customerHoursAllowed, setCustomerHoursAllowed] = useState(true);

  // Fetch the full customer record once a selection is made — needed
  // for billingCadence + hourlyRateMinor.
  const { data: selectedDetail } = useQuery({
    queryKey: ['admin-customer', selectedId],
    queryFn: () => customerAdminService.get(selectedId as number),
    enabled: !!selectedId,
  });

  // Landing aggregate — every customer with open (unbilled) hours. Only
  // fetched while no customer is picked; once one is selected the page
  // hands over to HoursSection. invalidated implicitly by remount on
  // re-entry (HoursSection mutations bump per-customer keys).
  const { data: summary = [], isLoading: summaryLoading } = useQuery({
    queryKey: ['admin-unbilled-hours-summary'],
    queryFn: () => customerAdminService.getUnbilledHoursSummary(),
    enabled: !selectedId,
  });

  const { data: profileSnapshot } = useQuery({
    queryKey: ['business-profile-snapshot'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60 * 1000,
  });
  const currency = profileSnapshot?.profile?.defaultCurrency || 'CHF';

  const selectFromSummary = (r: UnbilledHoursSummaryRow) => {
    setSelectedId(r.customerAccountId);
    setCustomerLabel(summaryLabel(r));
    setCustomerIsPassive(r.isPassive);
    setCustomerHoursAllowed(true);
  };

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
              {t('hoursLogging.title', 'Hours logging')}
            </h1>
            {/* Beta badge — matches Customers + Quotes + Contracts +
                Invoices so the whole /admin/clients tab reads as one
                product. */}
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {t('hoursLogging.subtitle',
              'Pick a customer and log billable time blocks. Entries flow into the next monthly bill or are billed on demand for per-event customers.')}
          </p>
        </div>
      </div>

      <Card padding="lg">
        <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">
          {t('hoursLogging.pickCustomer', 'Customer')}
        </label>
        <CustomerPicker
          value={selectedId}
          label={customerLabel}
          isPassive={customerIsPassive}
          requireFeature="hoursLogging"
          onSelect={(c: CustomerSummary) => {
            setSelectedId(c.id);
            setCustomerLabel(
              c.companyName
                || [c.firstName, c.lastName].filter(Boolean).join(' ')
                || c.displayName
                || c.email
                || `#${c.id}`,
            );
            setCustomerIsPassive(Boolean(c.isPassive));
            setCustomerHoursAllowed(c.featureHoursLogging !== false);
          }}
          onCreate={(c: CustomerAccountDetail) => {
            setSelectedId(c.id);
            setCustomerLabel(c.companyName || c.displayName || c.email || `#${c.id}`);
            setCustomerIsPassive(Boolean(c.isPassive));
            setCustomerHoursAllowed(c.featureHoursLogging !== false);
          }}
          onClear={() => {
            setSelectedId(null);
            setCustomerLabel('');
            setCustomerIsPassive(false);
            setCustomerHoursAllowed(true);
          }}
          searchPlaceholder={t('hoursLogging.searchPlaceholder',
            'Search by email or company…') as string}
        />
        {selectedId && !customerHoursAllowed && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            {t('hoursLogging.customerLoggingDisabled',
              "This customer has hour logging disabled. Enable it on the customer's detail page to log hours.")}
          </p>
        )}
      </Card>

      {!selectedId && (
        <Card padding="lg">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-neutral-500 dark:text-neutral-400" />
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              {t('hoursLogging.openHours.title', 'Open hours across all customers')}
            </h2>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
            {t('hoursLogging.openHours.subtitle',
              'Unbilled time blocks waiting to be billed. Pick a customer above, or click a row to drill in.')}
          </p>

          {summaryLoading ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 py-6 text-center">
              {t('common.loading', 'Loading…')}
            </p>
          ) : summary.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 py-6 text-center">
              {t('hoursLogging.openHours.empty',
                'No unbilled hours right now — everything is billed or no time has been logged yet.')}
            </p>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-700">
              {summary.map((r) => (
                <button
                  key={r.customerAccountId}
                  type="button"
                  onClick={() => selectFromSummary(r)}
                  className="w-full flex items-center justify-between gap-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/60 rounded-md px-2 -mx-2 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-neutral-900 dark:text-neutral-100 truncate">{summaryLabel(r)}</span>
                      {r.isPassive && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                          {t('hoursLogging.openHours.passive', 'Passive')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {t('hoursLogging.openHours.entryLine', {
                        count: r.entryCount,
                        hours: (r.totalMinutes / 60).toFixed(2),
                        defaultValue: '{{count}} entries · {{hours}}h',
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      {r.rateResolvable ? (
                        <div className="font-semibold text-neutral-900 dark:text-neutral-100 tabular-nums">
                          {formatMoneyMinor(r.openAmountMinor, currency)}
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-amber-700 dark:text-amber-300 text-xs">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          {t('hoursLogging.openHours.needsRate', 'Rate not set')}
                        </div>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-neutral-500 dark:text-neutral-400" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {selectedId && customerHoursAllowed && (
        <HoursSection
          customerId={selectedId}
          customerHourlyRateMinor={selectedDetail?.hourlyRateMinor ?? null}
          billingCadence={(selectedDetail?.billingCadence as any) || 'per_event'}
        />
      )}
    </div>
  );
};

export default HoursLoggingPage;
