import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyticsService } from '../analytics.service';
const fetchMock = vi.fn();
function fresh() { return new (analyticsService.constructor as new () => typeof analyticsService)(); }
beforeEach(() => {
  window.history.pushState({}, '', '/impressum');
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) }); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });
it.each(['umami', 'rybbit'] as const)('manually records eligible %s navigation without duplicate views', provider => {
  const service = fresh(); service.initialize({ provider });
  service.trackPageView('/impressum?secret=1#secret');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  window.history.pushState({}, '', '/gallery/wedding/%61bc?token=SECRET');
  service.handleRouteChange(window.location.pathname); service.trackPageView();
  service.trackPageView();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.lastCall![1].body).path).toBe('/gallery/wedding/[redacted]');
  window.history.pushState({}, '', '/customer/dashboard'); service.handleRouteChange(window.location.pathname);
  window.history.pushState({}, '', '/gallery/wedding/abc'); service.handleRouteChange(window.location.pathname); service.trackPageView();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it('drops every private representation, including custom event data and raw referrers', () => {
  window.history.pushState({}, '', '/gallery/wedding/short?share=SECRET#SECRET');
  document.title = 'SECRET customer';
  sessionStorage.setItem('gallery_token', 'SECRET'); localStorage.setItem('guest_token', 'SECRET');
  const storage = vi.spyOn(Storage.prototype, 'getItem');
  const title = vi.spyOn(document, 'title', 'get'); const referrer = vi.spyOn(document, 'referrer', 'get');
  const service = fresh(); service.initialize({ provider: 'umami' });
  service.trackPageView('/gallery/wedding/short', '/customer/reset-password/SECRET');
  service.trackGalleryEvent('password_entry', { gallery: 'SECRET', success: false, statusCode: 401, password: 'SECRET' });
  service.trackDownload(123, 'SECRET');
  service.trackSearch('SECRET', 7, 'gallery');
  service.track('lightbox_protection_violation', { photoId: 123, zoom: 2, protectionLevel: 'enhanced', violationType: 'keyboard_shortcut_SECRET' });
  expect(fetchMock).toHaveBeenCalledTimes(5);
  for (const [, options] of fetchMock.mock.calls) {
    expect(options.body).not.toContain('SECRET');
    expect(options.body).not.toContain('photoId');
    expect(options.body).not.toContain('gallery_token');
    expect(options.body).not.toContain('referrer');
    expect(options.body).not.toContain('title');
  }
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).data).toEqual({ success: false, statusCode: 401 });
  expect(JSON.parse(fetchMock.mock.lastCall![1].body).data).toEqual({ zoom: 2, protectionLevel: 'enhanced', violationType: 'keyboard_shortcut' });
  expect(storage).not.toHaveBeenCalled(); expect(title).not.toHaveBeenCalled(); expect(referrer).not.toHaveBeenCalled();
  sessionStorage.removeItem('gallery_token'); localStorage.removeItem('guest_token');
});
it.each(['doNotTrack', 'globalPrivacyControl'])('respects browser %s', preference => {
  const nav = Object.create(navigator); Object.defineProperty(nav, preference, { value: preference === 'doNotTrack' ? '1' : true });
  vi.stubGlobal('navigator', nav);
  const service = fresh(); service.initialize({ provider: 'umami', doNotTrack: false, autoTrack: true }); service.trackDownload(1, 'wedding');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('retains None, domain restrictions, and the admin-event no-op', () => {
  const service = fresh(); service.initialize({ provider: 'none' }); service.trackPageView(); service.trackDownload(1, 'wedding');
  const restricted = fresh(); restricted.initialize({ provider: 'umami', domains: ['not-this-host.example'] });
  restricted.trackDownload(1, 'wedding');
  service.trackAdminEvent('login');
  expect(fetchMock).not.toHaveBeenCalled();
});
