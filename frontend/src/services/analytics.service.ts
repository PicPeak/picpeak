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

export type TrackerProvider = 'none' | 'umami' | 'rybbit' | 'custom';

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
      track: (eventName: string, eventData?: any) => void;
      trackView: (url?: string, referrer?: string, websiteId?: string) => void;
      trackEvent: (
        eventValue: string,
        eventType: string,
        url?: string,
        websiteId?: string
      ) => void;
    };
    rybbit?: {
      event: (eventName: string, eventData?: any) => void;
      pageview?: () => void;
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
      const script = document.createElement('script');
      script.async = true;
      script.defer = true;
      script.src = `${config.hostUrl.replace(/\/+$/, '')}/script.js`;
      script.setAttribute('data-website-id', config.websiteId);
      if (config.autoTrack === false) script.setAttribute('data-auto-track', 'false');
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
      script.src = `${config.hostUrl.replace(/\/+$/, '')}/api/script.js`;
      script.setAttribute('data-site-id', config.websiteId);
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
      window.umami.track(eventName, eventData);
    } else if (this.provider === 'rybbit' && typeof window !== 'undefined' && window.rybbit) {
      window.rybbit.event(eventName, eventData);
    }
    // 'none' / 'custom' / unloaded → silently ignore.
  }

  trackPageView(url?: string, referrer?: string) {
    if (!this.initialized) return;
    if (this.provider === 'umami' && typeof window !== 'undefined' && window.umami) {
      window.umami.trackView(url, referrer, this.websiteId || undefined);
    } else if (this.provider === 'rybbit' && typeof window !== 'undefined' && window.rybbit?.pageview) {
      window.rybbit.pageview();
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
