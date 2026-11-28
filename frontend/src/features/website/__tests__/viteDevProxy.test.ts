// @vitest-environment node
/**
 * In the documented dev setup (Vite on 5173, backend on 3001) the website
 * builder's preview and pages load images, fonts and the sitemap from the
 * backend (issue 2618); without a proxy entry the SPA fallback answers them.
 */
import { expect, it } from 'vitest';
import type { ConfigEnv, UserConfig } from 'vite';
import config from '../../../../vite.config';

it('proxies the website paths to the backend next to /api', async () => {
  const resolved = await (config as (env: ConfigEnv) => UserConfig | Promise<UserConfig>)({ command: 'serve', mode: 'development' });
  const proxy = resolved.server?.proxy as Record<string, { target: string }>;
  for (const prefix of ['/api', '/site-media', '/sitemap.xml', '/fonts']) {
    expect(proxy[prefix]?.target).toBe('http://localhost:3001');
  }
  // The site root is not proxied: the dev server answers it with the app.
  expect(proxy['/']).toBeUndefined();
});
