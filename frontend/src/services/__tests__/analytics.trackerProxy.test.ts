/**
 * Pins the same-origin tracker URLs.
 *
 * Umami and Rybbit used to be injected with a `src` pointing at the admin's
 * own tracker domain, which the shipped CSP (`script-src 'self' …`,
 * `connect-src 'self' …`) always blocked — silently, with only a console
 * error. The script and its beacon now go through PicPeak's own origin
 * (`/api/analytics/tracker/*`, proxied by the backend), which `'self'`
 * already covers. If any of these URLs regress to the tracker's domain the
 * feature breaks again, invisibly, so the shapes are pinned here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { analyticsService } from '../analytics.service';

function lastScript(): HTMLScriptElement {
  const scripts = document.head.querySelectorAll('script');
  return scripts[scripts.length - 1] as HTMLScriptElement;
}

function freshService() {
  // The service is a module-level singleton with an `initialized` latch; each
  // case needs its own instance.
  return new (analyticsService.constructor as new () => typeof analyticsService)();
}

describe('analytics tracker script injection', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('loads the Umami script from PicPeak\'s own origin, not the tracker domain', () => {
    freshService().initialize({
      provider: 'umami',
      hostUrl: 'https://analytics.example.com',
      websiteId: 'site-123',
      doNotTrack: true,
    });

    const script = lastScript();
    expect(script.getAttribute('src')).toBe('/api/analytics/tracker/script.js');
    expect(script.getAttribute('src')).not.toContain('analytics.example.com');
    // Umami derives its collect endpoint as `<data-host-url>/api/send`, so
    // this is what keeps the beacon inside `connect-src 'self'` too.
    expect(script.getAttribute('data-host-url')).toBe('/api/analytics/tracker');
    expect(script.getAttribute('data-website-id')).toBe('site-123');
    // GHSA-7m6c: auto-track stays off so the raw gallery URL (which carries
    // the share token) never reaches the collector.
    expect(script.getAttribute('data-auto-track')).toBe('false');
  });

  it('loads the Rybbit script from a prefix its own host-derivation can parse', () => {
    freshService().initialize({
      provider: 'rybbit',
      hostUrl: 'https://rybbit.example.com',
      websiteId: 'site-456',
      doNotTrack: true,
      maskPatterns: ['/gallery/**'],
    });

    const script = lastScript();
    const src = script.getAttribute('src')!;
    expect(src).toBe('/api/analytics/tracker/script.js');
    // Rybbit computes `analyticsHost = src.split('/script.js')[0]` and then
    // calls `<host>/track`; the split has to land on our proxy prefix.
    expect(src.split('/script.js')[0]).toBe('/api/analytics/tracker');
    expect(script.getAttribute('data-site-id')).toBe('site-456');
    expect(script.getAttribute('data-mask-patterns')).toBe(JSON.stringify(['/gallery/**']));
  });

  it('injects nothing when the tracker URL is missing', () => {
    freshService().initialize({
      provider: 'umami',
      hostUrl: '',
      websiteId: 'site-123',
    });

    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });
});
