/**
 * The whole number a text field holds, or null.
 *
 * `parseInt` reads a prefix: "1e2" (which a number input accepts, and means
 * 100) becomes 1 and "2.5" becomes 2, so a form saved a value other than the
 * one on screen. The complete text has to be a whole number.
 */
export function parseWholeNumber(text: string): number | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const value = Number(text);
  return Number.isInteger(value) ? value : null;
}
