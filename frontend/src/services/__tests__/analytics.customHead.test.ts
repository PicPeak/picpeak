import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyticsService } from '../analytics.service';
beforeEach(() => { document.head.innerHTML = ''; });
afterEach(() => { document.head.innerHTML = ''; vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });
it.each(['/gallery/wedding/abc', '/admin', '/customer/dashboard', '/impressum'])('legacy custom HTML is inert on %s and every SPA navigation', path => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  window.history.pushState({}, '', path);
  const service = new (analyticsService.constructor as new () => typeof analyticsService)();
  service.initialize({ provider: 'custom', customHeadHtml: '<script>window.__customHeadRan = true</script><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="preload" href="https://evil.example">' } as never);
  for (const route of ['/gallery/wedding/short', '/customer/login', '/admin']) {
    window.history.pushState({}, '', route);
    service.handleRouteChange(route); service.trackPageView(); service.trackDownload(1, 'secret');
  }
  expect(service.isInitialized()).toBe(true);
  expect(document.head.querySelectorAll('script, iframe, meta, link')).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(Reflect.get(window, '__customHeadRan')).toBeUndefined();
});
