/**
 * The logo for the current colour mode: the dark-mode logo in dark mode and
 * the regular one otherwise, each falling back to the other when unset.
 */
export function pickThemedLogo(
  isDark: boolean,
  lightLogo: string | null | undefined,
  darkLogo: string | null | undefined,
): string | null | undefined {
  return isDark ? (darkLogo || lightLogo) : (lightLogo || darkLogo);
}
