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
    // One request at a time: visibility can flip while one is pending, and a
    // second sentinel nobody holds would keep the screen on for good.
    let pending: Promise<void> | null = null;
    let stopped = false;

    const acquire = () => {
      if (stopped || pending || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      pending = navigator.wakeLock.request('screen')
        .then((next) => {
          // Granted after the upload ended (or the page unmounted): let go.
          if (stopped) {
            next.release().catch(() => {});
            return;
          }
          if (lock && !lock.released) lock.release().catch(() => {});
          lock = next;
        }, () => {
          // Refused: the upload goes on without it.
        })
        .finally(() => { pending = null; });
    };

    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', acquire);
      lock?.release().catch(() => {});
      lock = null;
    };
  }, [active]);
}
