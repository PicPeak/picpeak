import { useEffect, useState } from 'react';

// setTimeout stores its delay in a signed 32-bit int; anything larger
// overflows and fires immediately. Events expiring weeks out don't need a
// live tick anyway, so we simply don't schedule past this horizon.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Fire `onExpiry` once, at the soonest future timestamp in `timestamps`
 * (#909 review). Admin expiry badges are computed inline from Date.now()
 * at render time, so without this a page left mounted across an event's
 * expiry keeps showing the stale "active"/"1 day left" state until an
 * unrelated render happens — which for editor/viewer roles (no health
 * poll) may never occur. When the callback updates state/data, the next
 * expiry reschedules automatically.
 */
export function useExpiryRefresh(
  timestamps: Array<string | null | undefined>,
  onExpiry: () => void,
): void {
  const next = timestamps
    .map((t) => (t ? new Date(t).getTime() : NaN))
    .filter((n) => Number.isFinite(n) && n > Date.now())
    .sort((a, b) => a - b)[0];

  // Bumped by a capped wake-up so the effect re-evaluates and re-arms when
  // the target is further out than a single setTimeout can represent.
  const [rearm, setRearm] = useState(0);
  useEffect(() => {
    if (next === undefined) return;
    // +1s so the timer lands just past the boundary, not exactly on it.
    const delay = next - Date.now() + 1000;
    if (delay > MAX_TIMEOUT_MS) {
      // Too far for one timer (setTimeout overflows past ~24.8 days and
      // fires immediately). Wake at the cap and re-arm with a now-smaller
      // remaining delay, so a page left mounted for weeks still updates.
      const id = window.setTimeout(() => setRearm((n) => n + 1), MAX_TIMEOUT_MS);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(onExpiry, Math.max(0, delay));
    return () => window.clearTimeout(id);
  }, [next, onExpiry, rearm]);
}
