/**
 * Pages whose URL carries a bearer secret — invitation, password reset,
 * quote, contract, payment-check and transfer tokens — must never load the
 * tracker: an auto-tracked page view would ship the token to the analytics
 * host, where anyone with access to the events could redeem it first
 * (Codex security audit 2026-09-30). Same treatment as the admin UI.
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
    '/INVITE/9f3a1c',
  ])('does not load the tracker when the visit starts on %s', (path) => {
    window.history.pushState({}, '', path);
    const service = freshService();
    service.initialize({ provider: 'rybbit', hostUrl: 'https://rybbit.example.com', websiteId: 'site-456' });
    expect(scripts()).toBe(0);
  });

  it('reloads into a clean document when a token page is entered after the tracker ran', () => {
    window.history.pushState({}, '', '/gallery/summer-party');
    const service = freshService();
    service.initialize({ provider: 'umami', hostUrl: 'https://analytics.example.com', websiteId: 'site-123' });
    expect(scripts()).toBe(1);
    service.handleRouteChange('/invite/9f3a1c');
    expect(service.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('still loads the tracker on an ordinary public page', () => {
    window.history.pushState({}, '', '/gallery/summer-party');
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
    service.handleRouteChange('/gallery/summer-party');
    expect(scripts()).toBe(1);
  });

  it('keeps custom head scripts off token pages too', () => {
    window.history.pushState({}, '', '/customer/reset-password/9f3a1c');
    const service = freshService();
    service.initialize({ provider: 'custom', customHeadHtml: '<script>window.__x = 1</script>' });
    expect(scripts()).toBe(0);
  });
});
