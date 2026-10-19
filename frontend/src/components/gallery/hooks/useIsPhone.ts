import { useEffect, useState } from 'react';

// Below Tailwind's `sm`: the widths where the gallery toolbar moves its
// selection actions into a bottom bar and its panels into bottom sheets.
export const PHONE_QUERY = '(max-width: 639px)';

function matches(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(PHONE_QUERY).matches;
}

/** True at phone widths; follows rotation and window resizes. */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return isPhone;
}
