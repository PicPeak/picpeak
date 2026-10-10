import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsService } from '../analytics.service';
const fetchMock = vi.fn();
function fresh() { return new (analyticsService.constructor as new () => typeof analyticsService)(); }
beforeEach(() => {
  document.head.innerHTML = '';
  window.history.pushState({}, '', '/gallery/wedding/short-secret?share=SECRET#SECRET');
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); document.head.innerHTML = ''; window.history.pushState({}, '', '/'); });

describe('PicPeak-owned tracker transport', () => {
  it.each(['umami', 'rybbit'] as const)('records exactly one initial %s page view without loading vendor code', provider => {
    const service = fresh();
    service.handleRouteChange(window.location.pathname); service.trackPageView();
    expect(fetchMock).not.toHaveBeenCalled();
    service.initialize({ provider, websiteId: 'site-1', autoTrack: true });
    service.trackPageView(window.location.pathname + window.location.search);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.head.querySelectorAll('script, iframe, link, meta')).toHaveLength(0);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/analytics/tracker/events');
    expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', keepalive: true });
    expect(JSON.parse(options.body)).toMatchObject({ type: 'pageview', path: '/gallery/wedding/[redacted]' });
    expect(options.body).not.toContain('SECRET'); expect(options.body).not.toContain('short-secret');
  });
  it('never invokes provider globals or inserts response-defined HTML/code', async () => {
    const track = vi.fn(); const event = vi.fn();
    Object.assign(window, { umami: { track }, rybbit: { event } });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ code: 'window.pwned=true',
      cache: { site: 'site-1', token: '<script>evil()</script>' } }) });
    const service = fresh(); service.initialize({ provider: 'umami' });
    service.trackDownload(1, 'secret-gallery');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(track).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled();
    expect(document.head.querySelectorAll('script, iframe')).toHaveLength(0);
    Reflect.deleteProperty(window, 'umami'); Reflect.deleteProperty(window, 'rybbit');
  });
  it('retains only a bounded opaque Umami cache token in memory', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ cache: { site: 'site-1', token: 'header.payload.signature' },
      sessionId: 'SECRET', html: '<script>evil()</script>' }) });
    const service = fresh(); service.initialize({ provider: 'umami' });
    await vi.waitFor(() => { service.trackDownload(1, 'private-gallery'); expect(JSON.parse(fetchMock.mock.lastCall![1].body).cache)
      .toEqual({ site: 'site-1', token: 'header.payload.signature' }); });
    expect(fetchMock.mock.lastCall![1].body).not.toContain('SECRET');
  });
  it('keeps analytics errors out of gallery/navigation workflows', () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const service = fresh();
    expect(() => service.initialize({ provider: 'rybbit' })).not.toThrow();
    expect(() => service.trackDownload(1, 'wedding')).not.toThrow();
  });
});
