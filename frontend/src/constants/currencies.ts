/**
 * Currency codes for the Business-profile "Default currency" dropdown.
 * CH/LI-first ordering (picpeak's primary scope), then the common EUR/USD/GBP
 * and a broad set of other ISO 4217 codes. Stored value is the bare 3-letter
 * code (e.g. "CHF").
 */
export const CURRENCY_CODES: string[] = [
  'CHF', 'EUR', 'USD', 'GBP',
  'AUD', 'CAD', 'CNY', 'CZK', 'DKK', 'HKD', 'HUF', 'ILS', 'INR', 'JPY',
  'NOK', 'NZD', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'ZAR',
];

/**
 * Normalise a stored/typed currency value to a known code. Upper-cases + trims
 * (so an old free-text "chf" resolves to "CHF"). Returns the matched code, or
 * the cleaned input if it isn't in the known list (caller preserves it as an
 * extra option so nothing is lost), or '' for empty input.
 */
export function normalizeCurrency(value: string | null | undefined): string {
  return (value || '').trim().toUpperCase();
}

/** Build the option list, prepending an unknown-but-set value so it's preserved. */
export function currencyOptions(current: string | null | undefined): string[] {
  const cur = normalizeCurrency(current);
  if (cur && !CURRENCY_CODES.includes(cur)) return [cur, ...CURRENCY_CODES];
  return CURRENCY_CODES;
}
