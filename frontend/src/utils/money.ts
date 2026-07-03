/**
 * Unified money formatting for the picpeak UI.
 *
 * Replaces the six near-duplicate `function formatMoney` blocks that
 * lived in LineItemsTable, CrmOverviewSection, PaymentCheckPage,
 * QuoteResponsePage, CustomerBillsPage, and CustomerQuotesPage. Each
 * copy had the SAME hardcoded `de-CH` locale fallback, meaning an
 * EN-locale operator saw German thousand-separators on every page; and
 * each copy varied on whether the `amount` was minor or major units —
 * leading to occasional 100× factor bugs when call-sites used the
 * wrong copy.
 *
 * Decisions baked in here:
 *   - Locale defaults to `i18next.language` (i.e. the active UI
 *     language), not de-CH. Call-sites can override with the `locale`
 *     option for special cases (e.g. always-DE PDF previews).
 *   - Two entry points: `formatMoney` for MAJOR units (preferred —
 *     matches what most templates and editor forms already pass), and
 *     `formatMoneyMinor` for MINOR units (use this when reading raw
 *     `*_amount_minor` columns).
 *   - Currency defaults to CHF when the call-site passes an empty
 *     string, mirroring the previous helpers' behaviour and matching
 *     the operator's default issuer currency.
 */

import i18next from 'i18next';

/**
 * Map an i18next language code to a BCP 47 locale that
 * `Intl.NumberFormat` accepts and that yields the conventional
 * separator + grouping rules for that language.
 *
 * We intentionally lean toward CH-flavoured variants for DE because
 * the operator's primary market is Switzerland (apostrophe-grouped
 * thousands, period decimal). Other locales fall through to their
 * canonical defaults.
 */
function languageToLocale(language?: string): string {
  if (!language) return 'de-CH';
  const base = language.toLowerCase().split('-')[0];
  switch (base) {
    case 'de': return 'de-CH';
    case 'en': return 'en-US';
    case 'fr': return 'fr-CH';
    case 'nl': return 'nl-NL';
    case 'pt': return 'pt-BR';
    case 'ru': return 'ru-RU';
    default:   return language;
  }
}

export interface FormatMoneyOptions {
  /**
   * BCP 47 locale override. When omitted, the active i18next language
   * is mapped to a sensible locale via {@link languageToLocale}.
   */
  locale?: string;
  /**
   * Force a specific fraction-digit count. Defaults to the
   * currency's `Intl.NumberFormat` default (2 for most currencies,
   * 0 for JPY etc.). Useful for whole-CHF totals in summary pills.
   */
  fractionDigits?: number;
}

function buildFormatter(currency: string, opts?: FormatMoneyOptions): Intl.NumberFormat {
  const locale = opts?.locale || languageToLocale(i18next.language);
  const numFormatOpts: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: (currency || 'CHF').toUpperCase(),
  };
  if (opts?.fractionDigits !== undefined) {
    numFormatOpts.minimumFractionDigits = opts.fractionDigits;
    numFormatOpts.maximumFractionDigits = opts.fractionDigits;
  }
  return new Intl.NumberFormat(locale, numFormatOpts);
}

/**
 * Format a MAJOR-unit amount (e.g. 12.5 for €12.50) as a localised
 * currency string. Pass `*_amount_minor` columns through
 * {@link formatMoneyMinor} instead — passing minor units here yields
 * a 100× over-display.
 */
export function formatMoney(
  amount: number,
  currency: string,
  opts?: FormatMoneyOptions,
): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return buildFormatter(currency, opts).format(safe);
}

/**
 * Format a MINOR-unit amount (the integer cents/Rappen stored in
 * `*_amount_minor` columns) as a localised currency string. Divides
 * by 100 before handing to Intl.NumberFormat.
 */
export function formatMoneyMinor(
  minor: number,
  currency: string,
  opts?: FormatMoneyOptions,
): string {
  const safe = Number.isFinite(minor) ? minor : 0;
  return buildFormatter(currency, opts).format(safe / 100);
}
