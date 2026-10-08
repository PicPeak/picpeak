import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyticsPath, analyticsService } from '../analytics.service';
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) }); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });
const PRIVATE_PATHS = ['/ADMIN/login', '/%61dmin', '/customer', '/CUSTOMER/dashboard', '/customer/reset-password/abc',
  '/s/abc', '/invite/abc', '/quote/abc', '/contract/signing', '/payment-check/abc', '/transfer/abc',
  '/transfer-upload/abc', '/slideshow/abc', '/gallery/wedding/client-access',
  '/gallery/wedding/show/short', '/gallery/wedding/%73how/%61bc', '/gallery/wedding/SHOW/short',
  '/gallery/wedding/%252fsecret',
  '/gallery/wedding/%3Fsecret', '/gallery/wedding/%00secret', '/unknown/nested'];
it.each(PRIVATE_PATHS)('does not emit views or events when starting or navigating onto %s', path => {
  window.history.pushState({}, '', path);
  const Service = analyticsService.constructor as new () => typeof analyticsService;
  const service = new Service(); service.initialize({ provider: 'umami' }); service.trackGalleryEvent('password_entry', { success: true });
  expect(fetchMock).not.toHaveBeenCalled();
  window.history.pushState({}, '', '/gallery/wedding/short');
  service.handleRouteChange(window.location.pathname); service.trackPageView();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  window.history.pushState({}, '', path);
  service.handleRouteChange(path); service.trackPageView('/impressum'); service.trackDownload(1, 'private');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each(['//customer/dashboard', '/gallery/../admin', 'https://external.example/gallery/wedding/abc', '/%ZZ', '/gallery/wedding/a\\b'])('fails closed for ambiguous representation %s', path => {
  expect(analyticsPath(path)).toBeNull();
});
it('uses the SPA route guard even if a late callback sees an older browser pathname', () => {
  window.history.pushState({}, '', '/gallery/wedding/abc');
  const service = new (analyticsService.constructor as new () => typeof analyticsService)();
  service.initialize({ provider: 'rybbit' }); fetchMock.mockClear();
  service.handleRouteChange('//customer/dashboard'); service.trackDownload(1, 'private'); service.trackPageView();
  expect(fetchMock).not.toHaveBeenCalled();
});
