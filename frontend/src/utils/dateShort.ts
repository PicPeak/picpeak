/**
 * formatShortDate — canonical DD.MM.YYYY formatter for public + customer
 * surfaces that don't have access to admin Settings (general_date_format).
 *
 * Five page files (PaymentCheckPage, QuoteResponsePage, CustomerBills/
 * Quotes/ContractsPage) previously carried identical copies. The
 * customer portal + public token routes deliberately use a fixed format
 * because they render on links the customer opens without any admin
 * locale context.
 *
 * Admin-side surfaces should use `useLocalizedDate` instead so they
 * honor the operator's general_date_format / general_time_format
 * settings. See `feedback_respect_general_format_settings.md`.
 */
export function formatShortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
