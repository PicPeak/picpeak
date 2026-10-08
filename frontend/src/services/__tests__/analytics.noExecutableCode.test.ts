import { afterEach, expect, it } from 'vitest';
import { analyticsService } from '../analytics.service';

afterEach(() => { document.head.innerHTML = ''; window.history.pushState({}, '', '/'); });

it.each(['umami', 'rybbit', 'custom'] as const)('never appends %s executable code on a gallery', (provider) => {
  window.history.pushState({}, '', '/gallery/wedding/short-secret?token=secret');
  const service = new (analyticsService.constructor as new () => typeof analyticsService)();
  service.initialize((provider === 'custom'
    ? { provider, customHeadHtml: '<script>fetch("/api/admin/users")</script>' }
    : { provider, websiteId: 'site-1', hostUrl: 'https://hostile.example' }) as never);
  expect(document.head.querySelectorAll('script, iframe, meta, link')).toHaveLength(0);
});
