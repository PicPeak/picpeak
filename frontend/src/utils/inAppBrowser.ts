/**
 * Detect when the page is loaded inside a known social-app in-app browser
 * (#654). These WKWebView / WebView wrappers — Instagram's IAB especially —
 * mangle password inputs in ways the host app can't override: keyboard
 * autocapitalisation overrides, predictive-text-appended trailing spaces,
 * stale saved-password autofill, smart-quote substitution. The result is
 * "Incorrect Password" on a byte-correct user input, with no visible cause.
 *
 * The cheapest mitigation is to detect the IAB UA and surface a banner
 * asking the user to open the link in their device's normal browser; the
 * gallery password form behaves correctly once we're out of the IAB.
 *
 * Detection uses navigator.userAgent. UA spoofing is possible but irrelevant
 * here — the banner is advisory; the legitimate IAB UA strings are stable.
 */

export type InAppBrowser = 'instagram';

export interface InAppBrowserDetection {
  // The detected IAB family, or null when the UA doesn't match.
  app: InAppBrowser | null;
  // Best-effort guess at the host platform so we can show the right copy
  // for the "open in browser" instructions (the menu lives in different
  // places on iOS vs Android).
  platform: 'ios' | 'android' | 'other';
}

/**
 * Detect whether the current navigator.userAgent matches a known IAB the
 * gallery password form has trouble with. SSR-safe (returns app: null
 * when window is undefined).
 */
export function detectInAppBrowser(): InAppBrowserDetection {
  if (typeof navigator === 'undefined' || typeof navigator.userAgent !== 'string') {
    return { app: null, platform: 'other' };
  }
  const ua = navigator.userAgent;

  let platform: InAppBrowserDetection['platform'] = 'other';
  if (/iPhone|iPad|iPod/i.test(ua)) platform = 'ios';
  else if (/Android/i.test(ua)) platform = 'android';

  // Instagram's IAB tags its UA with `Instagram <version>` on both iOS and
  // Android. Match case-insensitively so versioning quirks (`Instagram` vs
  // `instagram`) don't slip past.
  if (/\bInstagram\b/i.test(ua)) {
    return { app: 'instagram', platform };
  }

  return { app: null, platform };
}
