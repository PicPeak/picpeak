import { useMediaQuery } from './useMediaQuery';

// Below Tailwind's `sm`: the widths where the gallery toolbar moves its
// selection actions into a bottom bar and its panels into bottom sheets.
export const PHONE_QUERY = '(max-width: 639px)';

/** True at phone widths; follows rotation and window resizes. */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
