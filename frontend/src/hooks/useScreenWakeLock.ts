import { useEffect } from 'react';

/**
 * Best effort: keep the screen on while `active`, so a phone does not
 * auto-lock (and suspend the page) in the middle of a long upload.
 *
 * Feature-detected; browsers without the Screen Wake Lock API, or that
 * refuse it (battery saver, not visible), simply go without. The browser
 * drops the lock whenever the page is hidden, so it is taken again when the
 * page becomes visible, and released when `active` turns false or the
 * component unmounts.
 */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return undefined;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;

    const acquire = async () => {
      if (stopped || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (stopped) next.release().catch(() => {});
        else lock = next;
      } catch {
        // Refused: the upload goes on without it.
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', acquire);
      lock?.release().catch(() => {});
      lock = null;
    };
  }, [active]);
}
