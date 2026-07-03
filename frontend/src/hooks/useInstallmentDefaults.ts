/**
 * useInstallmentDefaults — fetch the three CRM-level installment
 * defaults seeded by migration 141:
 *
 *   - crm_invoices_installment_trigger_first      ('quote_accepted')
 *   - crm_invoices_installment_days_before_event  (14)
 *   - crm_invoices_installment_days_after_event   (14)
 *
 * Used by InstallmentsPanel on the Quote and Invoice editors so a
 * freshly-added installment row pre-populates with the admin's
 * preferred trigger shape instead of an empty value.
 *
 * Cached via react-query with a 5-min staleTime — these settings
 * change rarely and only via Settings → CRM. A `defaults` value is
 * always returned (hard-coded fallbacks before the fetch completes)
 * so callers don't have to guard a loading state.
 */
import { useQuery } from '@tanstack/react-query';
import { settingsService } from '../services/settings.service';
import type { PaymentTermInstallment } from '../services/quotes.service';

export interface InstallmentDefaults {
  triggerFirst: PaymentTermInstallment['trigger'];
  daysBeforeEvent: number;
  daysAfterEvent: number;
}

const HARDCODED_FALLBACK: InstallmentDefaults = {
  triggerFirst: 'quote_accepted',
  daysBeforeEvent: 14,
  daysAfterEvent: 14,
};

export function useInstallmentDefaults(): InstallmentDefaults {
  const { data } = useQuery({
    queryKey: ['installment-defaults'],
    queryFn: () => settingsService.getAllSettings(),
    staleTime: 5 * 60_000,
  });
  if (!data) return HARDCODED_FALLBACK;
  return {
    triggerFirst: (data.crm_invoices_installment_trigger_first as PaymentTermInstallment['trigger'])
      || HARDCODED_FALLBACK.triggerFirst,
    daysBeforeEvent: Number.isFinite(Number(data.crm_invoices_installment_days_before_event))
      ? Number(data.crm_invoices_installment_days_before_event)
      : HARDCODED_FALLBACK.daysBeforeEvent,
    daysAfterEvent: Number.isFinite(Number(data.crm_invoices_installment_days_after_event))
      ? Number(data.crm_invoices_installment_days_after_event)
      : HARDCODED_FALLBACK.daysAfterEvent,
  };
}
