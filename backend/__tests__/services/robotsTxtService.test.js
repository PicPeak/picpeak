/**
 * robots.txt must not hide the pages that refuse indexing themselves.
 *
 * A sign-in page blocked by robots.txt is never fetched, so a crawler never
 * sees its noindex and keeps the bare URL in its results. /admin, /customer
 * and the site root therefore stay crawlable and answer
 * "X-Robots-Tag: noindex" (isNoindexPath; the $spa_robots_tag map in
 * frontend/nginx.conf).
 */

let mockRows = [];
jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    select: jest.fn(() => Promise.resolve(mockRows)),
  })),
}));

const { generateRobotsTxt, clearRobotsTxtCache, isNoindexPath } = require('../../src/services/robotsTxtService');

const robots = async (settings) => {
  mockRows = Object.entries(settings).map(([setting_key, value]) => ({ setting_key, setting_value: JSON.stringify(value) }));
  clearRobotsTxtCache();
  return (await generateRobotsTxt()).split('\n');
};

describe('robots.txt', () => {
  it('never disallows /admin, with indexing on or off', async () => {
    for (const seo_allow_indexing of [true, false]) {
      const lines = await robots({ seo_allow_indexing });
      expect(lines).not.toContain('Disallow: /admin');
      expect(lines).toContain('Disallow: /api');
    }
  });

  it('with indexing off blocks everything but the pages that carry noindex', async () => {
    const lines = await robots({ seo_allow_indexing: false });
    expect(lines).toEqual(expect.arrayContaining(['Disallow: /', 'Allow: /$', 'Allow: /admin', 'Allow: /customer']));
  });

  it('with indexing on adds no blanket rule', async () => {
    const lines = await robots({ seo_allow_indexing: true, seo_block_ai_crawlers: false });
    expect(lines).not.toContain('Disallow: /');
    expect(lines.filter((line) => line.startsWith('Allow:'))).toEqual([]);
  });
});

describe('isNoindexPath', () => {
  it('covers the admin and customer-portal shells only', () => {
    for (const path of ['/admin', '/admin/login', '/admin/events/3', '/customer', '/customer/login']) {
      expect(isNoindexPath(path)).toBe(true);
    }
    for (const path of ['/', '/gallery/a', '/administrator', '/customers', '/setup', undefined]) {
      expect(isNoindexPath(path)).toBe(false);
    }
  });
});
