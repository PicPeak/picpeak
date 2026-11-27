// @vitest-environment node
/**
 * The Vite dev server answers / and the page slugs with the admin app, so
 * "Open site" needs the backend it proxies to (issue 2618). Only the dev
 * server gets that origin; a build never carries it.
 */
import { expect, it } from 'vitest';
import viteConfig from '../../../../vite.config';

const resolve = (command: 'serve' | 'build', mode: string) =>
  (typeof viteConfig === 'function' ? viteConfig({ command, mode, isSsrBuild: false, isPreview: false }) : viteConfig) as { define?: Record<string, string> };

it('gives the dev server the proxy target as the website origin, and a build nothing', () => {
  expect(resolve('serve', 'development').define?.__PICPEAK_DEV_SITE_ORIGIN__).toBe(JSON.stringify('http://localhost:3001'));
  expect(resolve('build', 'production').define?.__PICPEAK_DEV_SITE_ORIGIN__).toBeUndefined();
});
