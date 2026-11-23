/**
 * Constants and helpers the catalogue pages share (QuoteCatalogPage,
 * QuoteTemplateEditorPage, PricingFactorsTab).
 */
import type { LineUnit } from '../../../../utils/lineItemTotals';

export const UNITS: LineUnit[] = ['hour', 'day', 'piece', 'km', 'flat'];
export const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'];
export const LANGUAGES = ['de', 'en', 'fr', 'nl', 'pt', 'ru'];

// PricingFactorsTab keeps its own inputCls: its ring offset differs.
export const inputCls = 'w-full px-3 py-2 rounded-md border border-line-strong bg-panel text-heading text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900';
// Native selects ignore vertical padding in Safari; a fixed height keeps them level with the inputs.
export const selectCls = `${inputCls} h-10`;
export const labelCls = 'block text-sm font-medium text-body mb-1';

export const toMinor = (major: number) => Math.round((Number.isFinite(major) ? major : 0) * 100);

interface ApiError {
  message?: string;
  response?: { data?: { error?: string; details?: unknown } };
}
// The API's message, plus what each rejected field says (a 400 lists them in `details`).
export const errorText = (err: unknown): string => {
  const e = err as ApiError | null | undefined;
  const data = e?.response?.data;
  const details: Array<{ field?: string; message?: string }> = Array.isArray(data?.details) ? data.details : [];
  const reasons = details
    .map((d) => (d.message && d.message !== 'Invalid value' ? d.message : d.field ? `${d.field}: ${d.message || 'invalid'}` : null))
    .filter(Boolean);
  if (reasons.length) return reasons.join(' · ');
  return data?.error || e?.message || 'Failed';
};
