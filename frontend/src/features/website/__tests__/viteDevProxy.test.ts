/**
 * In the documented dev setup (Vite on 5173, backend on 3001) the website
 * builder's preview and pages load images, fonts and the sitemap from the
 * backend (issue 2618); without a proxy entry the SPA fallback answers them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('proxies the website paths to the backend next to /api', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../../vite.config.ts'), 'utf8');
  const proxy = source.slice(source.indexOf('proxy: {'));
  expect(source).toContain("const DEV_BACKEND = 'http://localhost:3001'");
  for (const prefix of ['/api', '/site-media', '/sitemap.xml', '/fonts']) {
    expect(proxy).toMatch(new RegExp(`'${prefix.replace('.', '\\.')}': \\{\\s*target: DEV_BACKEND,`));
  }
});
