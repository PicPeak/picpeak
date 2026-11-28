/**
 * The website's page views (issue 2618) stay small whatever visitors send:
 * at most 200 referrer domains a day (the rest count as "other"), one bucket
 * for every address with no page, rows kept for 400 days, statistics added
 * up in SQL, and at most 8 forwards to the tracker under way at once.
 */
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let pageViews;
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  pageViews = require('../../src/services/website/pageViews');
});
afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(async () => { await db('website_page_views').del(); });

const view = (over = {}) => pageViews.recordPageView({ slug: 'about', userAgent: BROWSER, referer: '', host: 'studio.example', ...over });

test('at most 200 referrer domains a day; the others count as "other"', async () => {
  for (let i = 0; i < 230; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await view({ referer: `https://spam${i}.example/x` });
  }
  // A domain already counted today keeps its own row.
  await view({ referer: 'https://spam3.example/y' });
  const domains = await db('website_page_views').distinct('referrer').pluck('referrer');
  expect(domains.length).toBe(201);
  expect(domains).toContain('other');
  const other = await db('website_page_views').where({ referrer: 'other' }).sum({ n: 'views' }).first();
  expect(Number(other.n)).toBe(30);
  const spam3 = await db('website_page_views').where({ referrer: 'spam3.example' }).sum({ n: 'views' }).first();
  expect(Number(spam3.n)).toBe(2);
});

test('rows older than 400 days are deleted', async () => {
  await db('website_page_views').insert([
    { day: '2020-01-01', page: 'about', referrer: '', device: 'desktop', views: 5 },
    { day: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), page: 'about', referrer: '', device: 'desktop', views: 3 },
  ]);
  pageViews._internal.forgetPurge();
  await view();
  expect(await db('website_page_views').where({ day: '2020-01-01' }).first()).toBeUndefined();
  expect(await db('website_page_views').count({ c: '*' }).first()).toMatchObject({ c: 2 });
});

test('statistics are added up in SQL: top lists are limited, the days complete', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ day: today, page: `p${i}`, referrer: `r${i}.example`, device: i % 2 ? 'mobile' : 'desktop', views: i + 1 });
  await db('website_page_views').insert(rows);
  const spy = jest.spyOn(db.client, 'query');
  const stats = await pageViews.pageViewStats(7);
  // No query reads the rows themselves.
  for (const [, q] of spy.mock.calls) expect(String(q.sql).toLowerCase()).toMatch(/sum\(|count\(/);
  spy.mockRestore();
  expect(stats.totals.views).toBe(465);
  expect(stats.topPages).toHaveLength(10);
  expect(stats.topPages[0]).toEqual({ page: 'p29', views: 30 });
  expect(stats.referrers).toHaveLength(10);
  expect(stats.chartData).toHaveLength(7);
  expect(stats.chartData[6]).toEqual({ date: today, views: 465 });
  expect(stats.devices.desktop + stats.devices.mobile).toBe(100);
});

test('at most 8 forwards to the tracker under way at once; beyond that they are dropped', async () => {
  const trackers = require('../../src/services/trackers/forwardEvent');
  await db('app_settings').where({ setting_key: 'analytics_website_forward' }).del();
  await db('app_settings').insert({ setting_key: 'analytics_website_forward', setting_value: JSON.stringify(true), setting_type: 'analytics', updated_at: new Date().toISOString() });
  jest.spyOn(trackers, 'optedOut').mockResolvedValue(false);
  jest.spyOn(trackers, 'resolveUpstream').mockResolvedValue({ provider: 'umami' });
  const release = [];
  const forward = jest.spyOn(trackers, 'forwardEvent').mockImplementation(() => new Promise((resolve) => release.push(resolve)));
  await Promise.all(Array.from({ length: 20 }, () => view()));
  await new Promise((r) => setTimeout(r, 50));
  expect(forward).toHaveBeenCalledTimes(8);
  release.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 20));
  await view();
  await new Promise((r) => setTimeout(r, 50));
  expect(forward).toHaveBeenCalledTimes(9);
  jest.restoreAllMocks();
});
