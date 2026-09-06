// Pluggable analytics service (#663 Phase 1).
//
// Routes initialization to the right tracker based on the operator's chosen
// provider in Settings → Analytics, and dispatches `track()` calls to the
// tracker's runtime API when one is loaded.
//
//   None    → no script, no-op tracking.
//   Umami   → inject Umami script tag; `window.umami.track(name, data)`.
//   Rybbit  → inject Rybbit script tag; `window.rybbit.event(name, data)`.
//   Custom  → render admin-pasted HTML (sanitised server-side) into <head>;
//             no runtime API hook — `track()` becomes a no-op.

import { getApiBaseUrl } from '../utils/url';

export type TrackerProvider = 'none' | 'umami' | 'rybbit' | 'custom';

// Umami and Rybbit scripts are loaded from PicPeak's OWN origin and proxied to
// the configured tracker by `backend/src/routes/analyticsTrackerProxy.js`.
// Loading them from the tracker's domain directly was always blocked by the
// shipped CSP (`script-src 'self' …`, and `connect-src 'self' …` for the
// beacon), which cannot be made dynamic in the Docker deployment — nginx
// serves index.html off disk and strips the backend's CSP header. Proxying
// removes the need for a CSP change entirely, and is what both vendors
// document for first-party tracking.
//
// Both scripts derive their collect endpoint from their own `src`:
//   Umami  — `<script-dir>/api/send` (also honours data-host-url, set below)
//   Rybbit — `src.split('/script.js')[0]` + `/track`
// so the single prefix below is all the backend has to expose.
const trackerProxyBase = (): string => `${getApiBaseUrl().replace(/\/+$/, '')}/analytics/tracker`;

interface BaseInitConfig {
  provider: TrackerProvider;
  autoTrack?: boolean;
  doNotTrack?: boolean;
}

interface UmamiInitConfig extends BaseInitConfig {
  provider: 'umami';
  websiteId: string;
  hostUrl: string;
  domains?: string[];
}

interface RybbitInitConfig extends BaseInitConfig {
  provider: 'rybbit';
  websiteId: string;
  hostUrl: string;
  // URL path patterns whose value must never reach the collector (they embed
  // the gallery share token). Rendered into Rybbit's data-mask-patterns.
  maskPatterns?: string[];
}

interface CustomInitConfig extends BaseInitConfig {
  provider: 'custom';
  customHeadHtml: string;
}

interface NoneInitConfig extends BaseInitConfig {
  provider: 'none';
}

type InitConfig = UmamiInitConfig | RybbitInitConfig | CustomInitConfig | NoneInitConfig;

declare global {
  interface Window {
    umami?: {
      // Current script.js (v2): `track(name, data)` sends a named event;
      // `track(fn)` sends fn(defaultPayload) — a payload without `name` is a
      // page view. This is the only page-view API the shipped tracker has.
      track?: {
        (eventName: string, eventData?: any): void;
        (payload: (props: Record<string, unknown>) => Record<string, unknown>): void;
      };
      // Legacy (v1) API. Absent from current script.js — calling it
      // unguarded is what threw on every admin route change (issue 1316).
      trackView?: (url?: string, referrer?: string, websiteId?: string) => void;
      trackEvent?: (
        eventValue: string,
        eventType: string,
        url?: string,
        websiteId?: string
      ) => void;
    };
    rybbit?: {
      event: (eventName: string, eventData?: any) => void;
      pageview?: (path?: string) => void;
    };
  }
}

class AnalyticsService {
  private initialized = false;
  private provider: TrackerProvider = 'none';
  private websiteId: string | null = null;

  initialize(config: InitConfig) {
    if (this.initialized) return;
    if (config.provider === 'none') {
      this.initialized = true;
      this.provider = 'none';
      return;
    }

    if (config.provider === 'umami') {
      if (!config.websiteId || !config.hostUrl) {
        console.warn('Umami: missing websiteId or hostUrl');
        return;
      }
      this.websiteId = config.websiteId;
      const proxyBase = trackerProxyBase();
      const script = document.createElement('script');
      script.async = true;
      script.defer = true;
      script.src = `${proxyBase}/script.js`;
      // Pin the collect host explicitly rather than relying on the tracker's
      // src-directory fallback: an Umami built with COLLECT_API_HOST set would
      // otherwise post straight to the tracker's domain and be blocked by
      // `connect-src 'self'`.
      script.setAttribute('data-host-url', proxyBase);
      script.setAttribute('data-website-id', config.websiteId);
      // Auto-track OFF by default (GHSA-7m6c): Umami's auto page-view capture
      // reads window.location verbatim, so a gallery URL /gallery/:slug/:token
      // would ship the secret share token to the analytics collector. Page
      // views are fired manually through trackPageView(), which redacts the
      // token. Only an explicit autoTrack:true opts back into raw capture.
      if (config.autoTrack !== true) script.setAttribute('data-auto-track', 'false');
      if (config.doNotTrack !== false) script.setAttribute('data-do-not-track', 'true');
      if (config.domains?.length) script.setAttribute('data-domains', config.domains.join(','));
      document.head.appendChild(script);
    } else if (config.provider === 'rybbit') {
      if (!config.websiteId || !config.hostUrl) {
        console.warn('Rybbit: missing websiteId or hostUrl');
        return;
      }
      this.websiteId = config.websiteId;
      const script = document.createElement('script');
      script.async = true;
      script.defer = true;
      // `/script.js` (not the upstream's `/api/script.js`): Rybbit's script
      // computes its analytics host as `src.split('/script.js')[0]`, so the
      // proxy prefix has to be the part before that literal segment.
      script.src = `${trackerProxyBase()}/script.js`;
      script.setAttribute('data-site-id', config.websiteId);
      // GHSA-7m6c: Rybbit auto-tracks page views (initial load + SPA route
      // changes) reading window.location, so a gallery URL would ship the raw
      // share token. Unlike Umami we CAN'T fix this with a manual tracker —
      // the initial-load pageview fires before any of our code runs. Instead
      // use Rybbit's native data-mask-patterns, which replaces matching paths
      // with the pattern string in analytics, stripping the token on every
      // auto-tracked pageview including the first.
      if (config.maskPatterns?.length) {
        script.setAttribute('data-mask-patterns', JSON.stringify(config.maskPatterns));
      }
      document.head.appendChild(script);
    } else if (config.provider === 'custom') {
      // The admin-pasted HTML is sanitised server-side (see
      // backend `customScriptSanitiser.js`). We render it via a wrapper
      // <div> and move each child node into <head> so <script> tags
      // execute. Using innerHTML on a <head> directly is also fine
      // here — the child nodes get parsed and inserted in order.
      const html = (config.customHeadHtml || '').trim();
      if (html) {
        const container = document.createElement('div');
        container.innerHTML = html;
        // Re-create <script> elements so the browser actually evaluates
        // them — assigning innerHTML to a parent inserts the nodes but
        // doesn't trigger script execution per the HTML spec.
        Array.from(container.childNodes).forEach((node) => {
          if (node.nodeName === 'SCRIPT') {
            const orig = node as HTMLScriptElement;
            const fresh = document.createElement('script');
            Array.from(orig.attributes).forEach((attr) => fresh.setAttribute(attr.name, attr.value));
            if (orig.textContent) fresh.textContent = orig.textContent;
            document.head.appendChild(fresh);
          } else {
            document.head.appendChild(node);
          }
        });
      }
    }

    this.provider = config.provider;
    this.initialized = true;
  }

  isInitialized() {
    return this.initialized;
  }

  // Track custom events. Dispatched to whichever tracker is loaded; custom
  // mode no-ops (we don't know the operator's tracker's runtime API).
  track(eventName: string, eventData?: Record<string, any>) {
    if (!this.initialized) return;
    if (this.provider === 'umami' && typeof window !== 'undefined' && window.umami) {
      window.umami.track?.(eventName, eventData);
    } else if (this.provider === 'rybbit' && typeof window !== 'undefined' && window.rybbit) {
      window.rybbit.event(eventName, eventData);
    }
    // 'none' / 'custom' / unloaded → silently ignore.
  }

  // Redact secrets from a URL before it reaches the analytics collector
  // (GHSA-7m6c): drop the query string entirely and replace token-looking
  // path segments (long hex / opaque IDs — e.g. the gallery share token in
  // /gallery/:slug/:token) with a placeholder. Failing safe: on any parse
  // issue return just the pathname without the query.
  private sanitizeTrackedUrl(url: string): string {
    try {
      const pathOnly = url.split('?')[0].split('#')[0];
      return pathOnly
        .split('/')
        .map((seg) =>
          /^[0-9a-fA-F]{16,}$/.test(seg) || /^[A-Za-z0-9_-]{20,}$/.test(seg) ? '[redacted]' : seg)
        .join('/');
    } catch {
      return url.split('?')[0];
    }
  }

  trackPageView(url?: string, referrer?: string) {
    if (!this.initialized) return;
    // Only Umami is manually tracked here: its auto-track is disabled (so the
    // raw token URL never hits the collector) and this sanitized call is the
    // ONLY page-view source. Rybbit keeps its own auto-tracking with
    // data-mask-patterns doing the redaction, so a manual call would
    // double-count — skip it. 'none'/'custom' have no page-view API.
    if (this.provider !== 'umami' || typeof window === 'undefined') return;
    // The script tag is injected async, so `window.umami` is absent until it
    // has loaded; a route change before that is simply not recorded.
    const umami = window.umami;
    if (!umami) return;
    const raw = url ?? window.location.pathname;
    const safe = this.sanitizeTrackedUrl(raw);
    try {
      if (typeof umami.track === 'function') {
        // Umami v2 page view: merge the sanitized URL into the tracker's own
        // default payload (website, screen, language, title, …). Without a
        // `name` the collector records it as a page view.
        umami.track((props) => ({
          ...props,
          url: safe,
          ...(referrer !== undefined ? { referrer } : {}),
        }));
      } else if (typeof umami.trackView === 'function') {
        umami.trackView(safe, referrer, this.websiteId || undefined);
      }
      // Neither API → no-op. Analytics must never break navigation.
    } catch (err) {
      console.warn('Analytics: page-view tracking failed', err);
    }
  }

  // Gallery-specific tracking events
  trackGalleryEvent(eventType: 'password_entry' | 'photo_view' | 'photo_download' | 'gallery_expired' | 'bulk_download', data?: any) {
    this.track(`gallery_${eventType}`, data);
  }

  trackAdminEvent(eventType: 'login' | 'event_created' | 'event_archived' | 'event_deleted' | 'settings_updated', data?: any) {
    this.track(`admin_${eventType}`, data);
  }

  trackDownload(photoId: string | number, gallerySlug: string, isBulk: boolean = false) {
    this.track('photo_download', {
      photo_id: photoId,
      gallery: gallerySlug,
      bulk: isBulk,
      timestamp: new Date().toISOString()
    });
  }

  trackExpirationWarning(gallerySlug: string, daysRemaining: number) {
    this.track('expiration_warning_viewed', {
      gallery: gallerySlug,
      days_remaining: daysRemaining,
      timestamp: new Date().toISOString()
    });
  }

  trackSearch(query: string, resultsCount: number, context: 'gallery' | 'admin') {
    this.track('search_performed', {
      query_length: query.length,
      results_count: resultsCount,
      context,
      timestamp: new Date().toISOString()
    });
  }
}

export const analyticsService = new AnalyticsService();

// Helper hook for React components
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export const useAnalytics = () => {
  const location = useLocation();

  useEffect(() => {
    // Track page views on route change
    analyticsService.trackPageView(location.pathname + location.search);
  }, [location]);

  return analyticsService;
};

// Renderless component that drives manual page-view tracking. MUST be mounted
// INSIDE <Router> (useLocation needs router context) — that's why the
// AnalyticsBootstrap init, which lives outside the Router, can't do this
// itself. Without a mounted caller trackPageView never fires and Umami — whose
// auto-track we deliberately disable — records nothing.
export const AnalyticsRouteTracker = (): null => {
  useAnalytics();
  return null;
};
