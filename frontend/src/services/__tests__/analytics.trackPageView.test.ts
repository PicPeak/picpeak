/**
 * Pins the page-view call against the Umami runtime API that is actually
 * loaded.
 *
 * Current Umami `script.js` exposes `window.umami = { track, identify }`;
 * `trackView` was the v1 API and is gone. `trackPageView()` used to call
 * `window.umami.trackView(...)` unguarded, so every admin route change threw
 * `TypeError: window.umami.trackView is not a function` (issue 1316). The
 * service must use `track()` when present, fall back to `trackView` on a
 * legacy script, and never throw when the script is missing or has neither.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { analyticsService } from '../analytics.service';

type UmamiGlobal = NonNullable<Window['umami']>;

function freshService() {
  // The service is a module-level singleton with an `initialized` latch; each
  // case needs its own instance.
  return new (analyticsService.constructor as new () => typeof analyticsService)();
}

function umamiService() {
  const service = freshService();
  service.initialize({
    provider: 'umami',
    hostUrl: 'https://analytics.example.com',
    websiteId: 'site-123',
    doNotTrack: true,
  });
  return service;
}

function setUmami(global: Partial<UmamiGlobal> | undefined) {
  (window as unknown as { umami?: Partial<UmamiGlobal> }).umami = global;
}

// What the real tracker hands to a `track(fn)` callback: its own default
// payload, built from the script's data-* attributes and window state.
const DEFAULT_PAYLOAD = {
  website: 'site-123',
  screen: '1280x800',
  language: 'en',
  title: 'PicPeak',
  hostname: 'picpeak.example.com',
  url: 'https://picpeak.example.com/admin/login',
  referrer: 'https://google.com/',
};

describe('analyticsService.trackPageView against the loaded Umami API', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  afterEach(() => {
    setUmami(undefined);
    document.head.innerHTML = '';
  });

  it('uses track() with a page-view payload when the script has no trackView (current Umami)', () => {
    const track = vi.fn();
    setUmami({ track });

    expect(() => umamiService().trackPageView('/impressum?page=2')).not.toThrow();

    expect(track).toHaveBeenCalledTimes(1);
    const [payloadFn] = track.mock.calls[0];
    expect(typeof payloadFn).toBe('function');

    const payload = payloadFn(DEFAULT_PAYLOAD);
    // Tracker defaults are preserved, only the URL is overridden — and the
    // query string is dropped by the sanitizer.
    expect(payload).toMatchObject({ ...DEFAULT_PAYLOAD, url: '/impressum' });
    // No `name` → Umami records a page view, not a custom event.
    expect(payload).not.toHaveProperty('name');
  });

  it('keeps the tracker\'s own referrer unless one is passed explicitly', () => {
    const track = vi.fn();
    setUmami({ track });
    const service = umamiService();

    service.trackPageView('/impressum');
    expect(track.mock.calls[0][0](DEFAULT_PAYLOAD).referrer).toBe(DEFAULT_PAYLOAD.referrer);

    service.trackPageView('/impressum', 'https://picpeak.example.com/datenschutz');
    expect(track.mock.calls[1][0](DEFAULT_PAYLOAD).referrer).toBe(
      'https://picpeak.example.com/datenschutz'
    );
  });

  // Gallery pages stay tracked (maintainer decision 2026-10-03): the share
  // token is redacted here and masked by Rybbit's maskPatterns (GHSA-7m6c).
  it('still redacts the gallery share token on the track() path (GHSA-7m6c)', () => {
    const track = vi.fn();
    setUmami({ track });

    umamiService().trackPageView('/gallery/summer-wedding/0123456789abcdef0123456789abcdef?x=1');

    expect(track.mock.calls[0][0](DEFAULT_PAYLOAD).url).toBe('/gallery/summer-wedding/[redacted]');
  });

  it('records nothing for a customer-portal or short-link page view, even while the tracker is loaded', () => {
    const track = vi.fn();
    setUmami({ track });

    umamiService().trackPageView('/customer/dashboard?tab=bills');
    umamiService().trackPageView('/customer');
    umamiService().trackPageView('/s/ab12cd');

    expect(track).not.toHaveBeenCalled();
  });

  it('falls back to the legacy trackView() when that is all the script offers', () => {
    const trackView = vi.fn();
    setUmami({ trackView });

    expect(() => umamiService().trackPageView('/impressum?page=2')).not.toThrow();

    expect(trackView).toHaveBeenCalledTimes(1);
    expect(trackView).toHaveBeenCalledWith('/impressum', undefined, 'site-123');
  });

  it('prefers track() over trackView() when a script exposes both', () => {
    const track = vi.fn();
    const trackView = vi.fn();
    setUmami({ track, trackView });

    umamiService().trackPageView('/impressum');

    expect(track).toHaveBeenCalledTimes(1);
    expect(trackView).not.toHaveBeenCalled();
  });

  it('is a no-op while the script has not loaded yet', () => {
    setUmami(undefined);

    expect(() => umamiService().trackPageView('/impressum')).not.toThrow();
  });

  it('is a no-op when the global has neither page-view API', () => {
    setUmami({ identify: vi.fn() } as unknown as Partial<UmamiGlobal>);

    expect(() => umamiService().trackPageView('/impressum')).not.toThrow();
  });

  it('does not let a throwing tracker break navigation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setUmami({
      track: () => {
        throw new Error('collector unreachable');
      },
    });

    expect(() => umamiService().trackPageView('/impressum')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
