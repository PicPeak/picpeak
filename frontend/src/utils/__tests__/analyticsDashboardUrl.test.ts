import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { analyticsDashboardUrl, analyticsDashboardFrameProps } from '../analyticsDashboardUrl';
afterEach(() => vi.unstubAllEnvs());
it.each(['javascript:alert(1)', 'data:text/html,evil', 'http://collector.example/share',
  '/api/analytics/tracker/script.js', window.location.origin + '/admin',
  'https://user:pass@collector.example/share'])('refuses executable or app-origin dashboard %s', raw => {
  expect(analyticsDashboardUrl(raw, null)).toBeNull();
});
it('also refuses the configured API hostname on any port', () => {
  vi.stubEnv('VITE_API_URL', 'https://api.picpeak.example/api');
  expect(analyticsDashboardUrl('https://api.picpeak.example:9443/anything', null)).toBeNull();
});
it('retains an HTTPS dashboard on an unrelated host', () => {
  expect(analyticsDashboardUrl('https://collector.example/share/private-link', null))
    .toBe('https://collector.example/share/private-link');
});
it('refuses another port on the app hostname, where auth cookies still apply', () => {
  expect(analyticsDashboardUrl(`https://${window.location.hostname}:9443/share`, null)).toBeNull();
});
it.each(['.picpeak.example', 'PICPEAK.EXAMPLE', '.picpeak.example.'])(
  'refuses collectors covered by authentication cookie domain %s', domain => {
    expect(analyticsDashboardUrl('https://collector.picpeak.example/share', domain)).toBeNull();
    expect(analyticsDashboardUrl('https://picpeak.example:9443/share', domain)).toBeNull();
  });
it('keeps unrelated hosts and lookalike suffixes outside the domain eligible', () => {
  expect(analyticsDashboardUrl('https://notpicpeak.example/share', '.picpeak.example'))
    .toBe('https://notpicpeak.example/share');
});
it('fails closed without a confirmed cookie domain or with malformed metadata', () => {
  expect(analyticsDashboardUrl('https://collector.example/share')).toBeNull();
  expect(analyticsDashboardUrl('https://collector.example/share', 'https://picpeak.example')).toBeNull();
});
it('never falls back to an ordinary iframe in an unsupported browser', () => {
  expect(analyticsDashboardFrameProps('https://collector.example/share', null)).toBeNull();
});
it('requires a credentialless sandbox without popup or top-navigation escape', () => {
  Object.defineProperty(HTMLIFrameElement.prototype, 'credentialless', { value: false, configurable: true });
  try {
    expect(analyticsDashboardFrameProps('https://collector.example/share', null)).toEqual({
      src: 'https://collector.example/share', credentialless: '',
      sandbox: 'allow-scripts allow-same-origin', referrerPolicy: 'no-referrer',
    });
    expect(analyticsDashboardFrameProps(`https://${window.location.hostname}:9443/share`, null)).toBeNull();
    expect(analyticsDashboardFrameProps('https://collector.example/share')).toBeNull();
    const props = analyticsDashboardFrameProps('https://collector.example/share', null)!;
    const view = render(createElement('iframe', props));
    expect(view.container.querySelector('iframe')).toHaveAttribute('credentialless', '');
    expect(view.container.querySelector('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  } finally {
    cleanup();
    Reflect.deleteProperty(HTMLIFrameElement.prototype, 'credentialless');
  }
});
