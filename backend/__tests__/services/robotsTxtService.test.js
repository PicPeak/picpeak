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
      expect(rules).toContain('Disallow: /api');
      for (const blocked of ['Disallow: /', 'Disallow: /admin', 'Disallow: /customer', 'Disallow: /gallery']) {
        expect(rules).not.toContain(blocked);
      }
    }
  });

  it('with indexing off blocks the media paths, which carry no noindex', async () => {
    expect(forEveryone(await robots({ seo_allow_indexing: false })))
      .toEqual(['Disallow: /api', 'Disallow: /photos', 'Disallow: /thumbnails', 'Disallow: /uploads', 'Disallow: /og']);
  });

  it('with indexing on blocks the API only', async () => {
    expect(forEveryone(await robots({ seo_allow_indexing: true }))).toEqual(['Disallow: /api']);
  });

  it('still shuts AI crawlers out entirely', async () => {
    const lines = await robots({ seo_allow_indexing: true, seo_blocked_ai_agents: ['GPTBot'] });
    expect(lines.slice(lines.indexOf('User-agent: GPTBot'))[1]).toBe('Disallow: /');
  });
});
