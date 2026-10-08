// PicPeak-owned telemetry: only data goes to the backend's closed /events
// endpoint. Never execute custom snippets, fetch vendor scripts, invoke
// vendor globals, or read application cookies/storage/DOM contents.
import { getApiBaseUrl } from '../utils/url';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export type TrackerProvider = 'none' | 'umami' | 'rybbit';
type InitConfig = { provider: TrackerProvider; doNotTrack?: boolean; autoTrack?: boolean;
  websiteId?: string; domains?: string[] };
type Cache = { site: string; token: string };
const PRIVATE_ROOTS = new Set(['admin', 'customer', 's', 'invite', 'quote', 'contract',
  'payment-check', 'transfer', 'transfer-upload', 'slideshow']);
const EVENT_NAMES = new Set([
  'gallery_password_entry', 'gallery_photo_view', 'gallery_photo_download',
  'gallery_gallery_expired', 'gallery_bulk_download', 'photo_download',
  'expiration_warning_viewed', 'search_performed', 'gallery_devtools_detected',
  'thumbnail_protection_violation', 'lightbox_devtools_detected', 'lightbox_protection_violation',
]);
const NUMBERS = new Set(['photo_count', 'days_remaining', 'query_length', 'results_count', 'statusCode', 'zoom']);
const BOOLEANS = new Set(['success', 'bulk', 'is_download_all']);
const ENUMS: Record<string, readonly string[]> = {
  context: ['gallery'],
  protectionLevel: ['basic', 'standard', 'enhanced', 'maximum'],
  violationType: ['devtools_detected', 'print_screen_detected', 'canvas_access_blocked',
    'right_click', 'drag_attempt', 'keyboard_shortcut', 'screenshot_attempt',
    'context_menu', 'print_attempt', 'canvas_access', 'save_attempt', 'drag_start',
    'text_selection', 'suspicious_visibility_change', 'clipboard_copy', 'clipboard_paste'],
};

// Kept in sync with backend analyticsEventPolicy and tested on both sides.
// Gallery suffixes are structurally redacted, never classified by length.
export function analyticsPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith('/')) return null;
  let path: string;
  try { path = decodeURIComponent(raw.split(/[?#]/)[0]); } catch { return null; }
  if (/[\\%?#]/.test(path) || Array.from(path).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) return null;
  const first = (parts[0] || '').toLowerCase();
  if (PRIVATE_ROOTS.has(first)) return null;
  if (first === 'gallery') {
    if (!parts[1] || !/^[A-Za-z0-9_-]{1,100}$/.test(parts[1])
      || ['client-access', 'show'].includes((parts[2] || '').toLowerCase())) return null;
    return '/gallery/' + parts[1] + (parts.length > 2 ? '/[redacted]' : '');
  }
  if (!parts.length) return '/';
  return parts.length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(parts[0]) ? '/' + parts[0] : null;
}

function eventProperties(data?: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return safe;
  for (const [key, raw] of Object.entries(data)) {
    // Count blocked shortcuts, not their key contents.
    const value = key === 'violationType' && typeof raw === 'string' && raw.startsWith('keyboard_shortcut_')
      ? 'keyboard_shortcut' : raw;
    if ((NUMBERS.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000)
      || (BOOLEANS.has(key) && typeof value === 'boolean')
      || (Object.prototype.hasOwnProperty.call(ENUMS, key) && typeof value === 'string' && ENUMS[key].includes(value))) {
      safe[key] = value;
    }
  }
  return safe;
}

class AnalyticsService {
  private initialized = false;
  private provider: TrackerProvider = 'none';
  private routePath = '';
  private lastPageView: string | null = null;
  private cache?: Cache;
  private domains?: string[];

  initialize(config: InitConfig) {
    if (this.initialized) return;
    // Anything else, a legacy custom configuration included, stays inert.
    this.provider = config.provider === 'umami' || config.provider === 'rybbit' ? config.provider : 'none';
    this.domains = config.domains;
    this.initialized = true;
    this.routePath = window.location.pathname;
    // Settings resolve after the initial route effect. Record the first
    // eligible view now; deduplication also covers React StrictMode effects.
    this.trackPageView();
  }

  isInitialized() { return this.initialized; }

  handleRouteChange(pathname: string) {
    this.routePath = pathname;
    if (!analyticsPath(pathname)) this.lastPageView = null;
  }

  private canTrack() {
    return this.initialized && this.provider !== 'none'
      && analyticsPath(this.routePath) !== null
      && analyticsPath(window.location.pathname) !== null
      && navigator.doNotTrack !== '1'
      && (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl !== true
      && (!this.domains?.length || this.domains.includes(window.location.hostname));
  }

  private async send(type: 'pageview' | 'event', path: string, name?: string, data?: Record<string, unknown>) {
    if (!this.canTrack()) return;
    const size = (n: number) => Number.isInteger(n) && n >= 0 && n <= 9999 ? n : 0;
    const language = /^[A-Za-z0-9-]{0,35}$/.test(navigator.language) ? navigator.language : '';
    try {
      const response = await fetch(getApiBaseUrl().replace(/\/+$/, '') + '/analytics/tracker/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', keepalive: true,
        body: JSON.stringify({
          type, path, hostname: window.location.hostname, language,
          screenWidth: size(window.screen.width), screenHeight: size(window.screen.height),
          ...(type === 'event' ? { name, data } : {}),
          ...(this.provider === 'umami' && this.cache ? { cache: this.cache } : {}),
        }),
      });
      if (this.provider === 'umami' && response.ok) {
        const result: unknown = await response.json();
        const candidate = (result as { cache?: Cache } | null)?.cache;
        if (candidate && typeof candidate.site === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(candidate.site)
          && typeof candidate.token === 'string' && candidate.token.length <= 2048
          && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate.token)) {
          this.cache = { site: candidate.site, token: candidate.token };
        }
      }
    } catch { /* Analytics failures must not affect navigation or gallery use. */ }
  }

  track(eventName: string, eventData?: Record<string, unknown>) {
    if (!EVENT_NAMES.has(eventName) || !this.canTrack()) return;
    const path = analyticsPath(window.location.pathname);
    if (path) void this.send('event', path, eventName, eventProperties(eventData));
  }

  trackPageView(url?: string, _referrer?: string) {
    if (!this.canTrack()) return;
    const path = analyticsPath(url ?? window.location.pathname);
    if (!path || path === this.lastPageView) return;
    this.lastPageView = path;
    void this.send('pageview', path);
  }

  trackGalleryEvent(eventType: 'password_entry' | 'photo_view' | 'photo_download' | 'gallery_expired' | 'bulk_download', data?: Record<string, unknown>) {
    this.track('gallery_' + eventType, data);
  }
  // Admin routes are deliberately excluded, including late async callbacks.
  trackAdminEvent(_eventType: 'login' | 'event_created' | 'event_archived' | 'event_deleted' | 'settings_updated', _data?: Record<string, unknown>) {}

  trackDownload(_photoId: string | number, _gallerySlug: string, isBulk = false) {
    this.track('photo_download', { bulk: isBulk });
  }
  trackExpirationWarning(_gallerySlug: string, daysRemaining: number) {
    this.track('expiration_warning_viewed', { days_remaining: daysRemaining });
  }
  trackSearch(query: string, resultsCount: number, context: 'gallery' | 'admin') {
    if (context === 'gallery') this.track('search_performed', { query_length: query.length, results_count: resultsCount, context });
  }
}
export const analyticsService = new AnalyticsService();
export const useAnalytics = () => {
  const location = useLocation();
  useEffect(() => {
    analyticsService.handleRouteChange(location.pathname);
    analyticsService.trackPageView(location.pathname);
  }, [location]);
  return analyticsService;
};
export const AnalyticsRouteTracker = (): null => { useAnalytics(); return null; };
