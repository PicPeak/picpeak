import { useEffect, useRef } from 'react';

interface UseDevToolsProtectionOptions {
  enabled: boolean;
  onDevToolsDetected?: () => void;
  redirectOnDetection?: boolean;
  redirectUrl?: string;
  detectionSensitivity?: 'low' | 'medium' | 'high';
}

/**
 * DevTools deterrent for protected galleries. This is a deterrent, never a
 * security boundary — anything running in the page can be disabled by whoever
 * is determined enough to open DevTools in the first place.
 *
 * It therefore stays passive. The previous implementation polled a battery of
 * "aggressive" detectors (a bare `debugger;` trap, console monkey-patching,
 * `console.clear()`/`console.log()` probes) every tick. With any debugger or
 * CDP client attached, the `debugger` trap paused the page continuously, so
 * *every* interaction died — navigation, buttons, forms, links — not just
 * image saving, and the guest's console was wiped in a loop. A guest who had
 * DevTools open for an unrelated reason got a silently unresponsive gallery.
 *
 * What is left: the docked-DevTools viewport heuristic (a pure measurement,
 * no side effects) and the DevTools shortcut keys. Undocked DevTools is
 * deliberately not detected — every technique that catches it costs the page
 * its responsiveness for everyone.
 */
export const useDevToolsProtection = (options: UseDevToolsProtectionOptions) => {
  const isDetectedRef = useRef(false);

  // Options are rebuilt on every render by the callsites. Read them through a
  // ref so the effect below binds its listeners once per `enabled` change
  // instead of tearing them down and re-running detection on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const { enabled, detectionSensitivity } = options;

  useEffect(() => {
    if (!enabled) return;

    const handleDevToolsDetected = () => {
      if (isDetectedRef.current) return; // Prevent multiple triggers
      isDetectedRef.current = true;

      optionsRef.current.onDevToolsDetected?.();

      if (optionsRef.current.redirectOnDetection) {
        const redirectUrl = optionsRef.current.redirectUrl || '/';
        setTimeout(() => {
          window.location.href = redirectUrl;
        }, 100);
      }
    };

    // A docked DevTools panel eats a chunk of the viewport without changing
    // the window's outer size. Browser chrome (toolbar + bookmarks bar) alone
    // accounts for ~140px, so the threshold stays well above that to avoid
    // punishing a guest for having a bookmarks bar.
    const threshold = detectionSensitivity === 'high' ? 160 :
                      detectionSensitivity === 'low' ? 260 : 200;

    // The outer/inner gap is measured RELATIVE to a baseline taken when the
    // hook mounts, not as an absolute number. innerHeight is in page CSS px
    // (it shrinks under browser zoom) while outerHeight is not, so at 150-200%
    // zoom the absolute gap on a normal window is 400-500px — an
    // accessibility zoom looked exactly like a docked panel and, at
    // protectionLevel "maximum", bounced the guest off the gallery on load.
    // A zoom step changes devicePixelRatio; docking DevTools does not. So the
    // baseline is re-taken whenever the ratio changes, and only a gap that
    // grows past the threshold at a constant ratio counts as DevTools.
    const measure = () => ({
      dpr: window.devicePixelRatio || 1,
      height: window.outerHeight - window.innerHeight,
      width: window.outerWidth - window.innerWidth,
    });
    let baseline = measure();

    const detectByWindowSize = () => {
      const now = measure();
      if (now.dpr !== baseline.dpr) {
        baseline = now;
        return;
      }
      if (now.height - baseline.height > threshold ||
          now.width - baseline.width > threshold) {
        handleDevToolsDetected();
      }
    };

    // Block F12 and the DevTools shortcuts. Only these exact combinations are
    // touched — every other key event passes through untouched.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
        (e.ctrlKey && e.key === 'U')
      ) {
        e.preventDefault();
        e.stopPropagation();
        handleDevToolsDetected();
        return false;
      }
    };

    // Right-click is blocked on the images themselves only. Blocking it
    // document-wide also killed the context menu on text, links and form
    // fields, which has nothing to do with saving a photo (the event-level
    // `disable_right_click` setting is what covers the whole page).
    const handleImageContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (tagName === 'IMG' || tagName === 'CANVAS' || tagName === 'VIDEO') {
        e.preventDefault();
      }
    };

    document.addEventListener('contextmenu', handleImageContextMenu);
    document.addEventListener('keydown', handleKeyDown, true);
    // Docking/undocking DevTools resizes the viewport. There is deliberately
    // no check at mount: a panel that was already open when the gallery
    // loaded is indistinguishable from a zoomed window at that point, and
    // the shortcut-key deterrent above still applies.
    window.addEventListener('resize', detectByWindowSize);

    return () => {
      document.removeEventListener('contextmenu', handleImageContextMenu);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', detectByWindowSize);
    };
  }, [enabled, detectionSensitivity]);

  return {
    isDetected: isDetectedRef.current,
    reset: () => {
      isDetectedRef.current = false;
    }
  };
};
