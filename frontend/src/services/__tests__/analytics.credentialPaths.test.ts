/**
 * Pages whose URL carries a bearer secret — invitation, password reset,
 * quote, contract, payment-check and transfer tokens — must never load the
 * tracker: an auto-tracked page view would ship the token to the analytics
 * host, where anyone with access to the events could redeem it first
 * (Codex security audit 2026-09-30). Same treatment as the admin UI.
 *
 * Extended 2026-10-03 to the gallery tree (/gallery/:slug/:token, the
 * slideshow, client access, /s/ short links) and the whole customer portal:
 * the share token and the portal session are credentials too, and the
 * tracker script — vendor code re-served through our origin, or admin-pasted
 * custom head HTML — runs with whatever those pages can do.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { analyticsService } from '../analytics.service';

function freshService() {
  const service = new (analyticsService.constructor as new () => typeof analyticsService)();
  service.reloadPage = vi.fn();
  return service;
}
const scripts = () => document.head.querySelectorAll('script').length;

describe('tracker and token-bearing pages', () => {
  beforeEach(() => { document.head.innerHTML = ''; });
  afterEach(() => { document.head.innerHTML = ''; window.history.pushState({}, '', '/'); });

  it.each([
    '/invite/9f3a1c',
    '/quote/9f3a1c',
    '/contract/9f3a1c',
    '/payment-check/9f3a1c',
    '/transfer/9f3a1c',
    '/transfer-upload/9f3a1c',
    '/customer/invite/9f3a1c',
    '/customer/reset-password/9f3a1c',
    '/customer/login',
    '/customer/dashboard',
    '/customer/bills',
    '/customer',
    '/gallery/summer-party',
    '/gallery/summer-party/0123456789abcdef0123456789abcdef',
    '/gallery/summer-party/show/0123456789abcdef0123456789abcdef',
    '/gallery/summer-party/client-access',
    '/gallery/preview',
    '/s/ab12cd',
    '/GALLERY/summer-party',
    '/INVITE/9f3a1c',
  ])('does not load the tracker when the visit starts on %s', (path) => {
    window.history.pushState({}, '', path);
    const service = freshService();
    service.initialize({ provider: 'rybbit', hostUrl: 'https://rybbit.example.com', websiteId: 'site-456' });
    expect(scripts()).toBe(0);
  });

  it.each([
    '/invite/9f3a1c',
    '/gallery/summer-party/0123456789abcdef0123456789abcdef',
    '/customer/login',
    '//gallery/summer-party',
  ])('reloads into a clean document when %s is entered after the tracker ran', (path) => {
    window.history.pushState({}, '', '/impressum');
    const service = freshService();
    service.initialize({ provider: 'umami', hostUrl: 'https://analytics.example.com', websiteId: 'site-123' });
    expect(scripts()).toBe(1);
    service.handleRouteChange(path);
    expect(service.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('records no page view for a gallery or portal path while the tracker is still loaded', () => {
    // useAnalytics fires handleRouteChange (which schedules the reload) and
    // trackPageView in the same effect, so the guard has to be in
    // trackPageView itself.
    window.history.pushState({}, '', '/impressum');
    const service = freshService();
    service.initialize({ provider: 'umami', hostUrl: 'https://analytics.example.com', websiteId: 'site-123' });
    const track = vi.fn();
    (window as unknown as { umami?: { track: typeof track } }).umami = { track };
    try {
      service.trackPageView('/gallery/summer-party/0123456789abcdef0123456789abcdef');
      service.trackPageView('/customer/dashboard?tab=bills');
      service.trackPageView('/s/ab12cd');
      expect(track).not.toHaveBeenCalled();
      service.trackPageView('/datenschutz');
      expect(track).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { umami?: unknown }).umami;
    }
  });

  it('still loads the tracker on an ordinary public page', () => {
    window.history.pushState({}, '', '/impressum');
    const service = freshService();
    service.initialize({ provider: 'rybbit', hostUrl: 'https://rybbit.example.com', websiteId: 'site-456' });
    expect(scripts()).toBe(1);
  });

  it('does not inject deferred custom scripts when the route changes onto a token page', () => {
    window.history.pushState({}, '', '/invite/9f3a1c');
    const service = freshService();
    service.initialize({ provider: 'custom', customHeadHtml: '<script>window.__x = 1</script>' });
    expect(scripts()).toBe(0);
    service.handleRouteChange('/invite/9f3a1c?step=2');
    expect(scripts()).toBe(0);
    service.handleRouteChange('/impressum');
    expect(scripts()).toBe(1);
  });

  it.each([
    '/customer/reset-password/9f3a1c',
    '/customer/dashboard',
    '/gallery/summer-party/0123456789abcdef0123456789abcdef',
  ])('keeps custom head scripts off %s too', (path) => {
    window.history.pushState({}, '', path);
    const service = freshService();
    service.initialize({ provider: 'custom', customHeadHtml: '<script>window.__x = 1</script>' });
    expect(scripts()).toBe(0);
  });
});
