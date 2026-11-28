/**
 * robots.txt must not hide the pages that refuse indexing themselves.
 *
 * A page blocked by robots.txt is never fetched, so a crawler never sees its
 * noindex and keeps the bare URL in its results. Every app page answers
 * "X-Robots-Tag: noindex" (frontend/nginx.conf; sendSpa in server.js), so
 * robots.txt leaves the pages crawlable and blocks only what carries no such
 * header.
 */

let mockRows = [];
jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    select: jest.fn(() => Promise.resolve(mockRows)),
  })),
}));

// The website builder (issue 2618) is off unless a case turns it on.
const mockWebsiteActive = jest.fn(async () => false);
jest.mock('../../src/services/website/service', () => ({ isWebsiteActive: () => mockWebsiteActive() }));
jest.mock('../../src/utils/frontendUrl', () => ({ getFrontendBaseUrl: async () => 'https://studio.example' }));

const { generateRobotsTxt, clearRobotsTxtCache } = require('../../src/services/robotsTxtService');

const robots = async (settings) => {
  mockRows = Object.entries(settings).map(([setting_key, value]) => ({ setting_key, setting_value: JSON.stringify(value) }));
  clearRobotsTxtCache();
  return (await generateRobotsTxt()).split('\n');
};
// The rules of the `User-agent: *` groups only.
const forEveryone = (lines) => {
  const rules = [];
  let mine = false;
  for (const line of lines) {
    if (line.startsWith('User-agent:')) mine = line === 'User-agent: *';
    else if (mine && /^(Dis)?allow:/i.test(line)) rules.push(line);
  }
  return rules;
};

describe('robots.txt', () => {
  it('never keeps a crawler away from the pages, with indexing on or off', async () => {
    for (const seo_allow_indexing of [true, false]) {
      const rules = forEveryone(await robots({ seo_allow_indexing }));
      expect(rules).toContain('Disallow: /api/');
      for (const blocked of ['Disallow: /', 'Disallow: /admin', 'Disallow: /customer', 'Disallow: /gallery']) {
        expect(rules).not.toContain(blocked);
      }
    }
  });

  it('with indexing off blocks the media paths, which carry no noindex', async () => {
    expect(forEveryone(await robots({ seo_allow_indexing: false })))
      .toEqual(['Disallow: /api/', 'Disallow: /photos/', 'Disallow: /thumbnails/', 'Disallow: /uploads/', 'Disallow: /og/', 'Disallow: /site-media/']);
  });

  it('with indexing on blocks the API only', async () => {
    expect(forEveryone(await robots({ seo_allow_indexing: true }))).toEqual(['Disallow: /api/']);
  });

  it('blocks whole path segments, so a website page named like one stays crawlable', async () => {
    // A Disallow is a prefix match: "/api" would also cover a page at /apiary.
    for (const seo_allow_indexing of [true, false]) {
      const blocked = forEveryone(await robots({ seo_allow_indexing })).map((rule) => rule.replace('Disallow: ', ''));
      for (const page of ['/apiary', '/api-docs', '/photos-of-us', '/uploads-guide', '/og-image-tips', '/site-media-kit']) {
        expect(blocked.filter((prefix) => page.startsWith(prefix))).toEqual([]);
      }
      expect(blocked.some((prefix) => '/api/public/settings'.startsWith(prefix))).toBe(true);
    }
  });

  it('names the website sitemap while the website is live and indexable', async () => {
    mockWebsiteActive.mockResolvedValue(true);
    expect(await robots({ seo_allow_indexing: true })).toContain('Sitemap: https://studio.example/sitemap.xml');
    expect(await robots({ seo_allow_indexing: false })).not.toContain('Sitemap: https://studio.example/sitemap.xml');
    expect(await robots({ seo_allow_indexing: true, seo_sitemap_url: 'https://cdn.example/s.xml' })).not.toContain('Sitemap: https://studio.example/sitemap.xml');
    mockWebsiteActive.mockResolvedValue(false);
    expect(await robots({ seo_allow_indexing: true })).not.toContain('Sitemap: https://studio.example/sitemap.xml');
  });

  it('still shuts AI crawlers out entirely', async () => {
    const lines = await robots({ seo_allow_indexing: true, seo_blocked_ai_agents: ['GPTBot'] });
    expect(lines.slice(lines.indexOf('User-agent: GPTBot'))[1]).toBe('Disallow: /');
  });
});
