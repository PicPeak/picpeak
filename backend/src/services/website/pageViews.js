/**
 * The website's page views (issue 2618), counted server-side: per day, page,
 * referrer domain and device class, nothing else. No cookies, no script, no
 * address or user agent stored; crawlers and tools are not counted, and
 * nothing is counted or forwarded while analytics is off (Settings › General).
 *
 * Bounded whatever visitors send: the page is a published page's slug or
 * the one not-found bucket (the caller decides, server.js), at most
 * MAX_REFERRERS_A_DAY referrer domains a day (the rest count as "other"),
 * rows are kept KEEP_DAYS days, the statistics are added up in SQL, and at
 * most MAX_FORWARDS forwards to the tracker are under way at once.
 */
const MAX_REFERRERS_A_DAY = 200;
const KEEP_DAYS = 400;
const MAX_FORWARDS = 8;
const NOT_FOUND_PAGE = '(not found)';
const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const { isBot, deviceClass } = require('../../utils/userAgentClass');
const { getAppSetting } = require('../../utils/appSettings');
const { parseBooleanInput } = require('../../utils/parsers');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const trackers = require('../trackers/forwardEvent');

/** The referring site's domain; '' for none or the site's own pages. */
function referrerDomain(referer, ownHost) {
  if (!referer) return '';
  let host;
  let own = '';
  try { host = new URL(referer).hostname.toLowerCase(); } catch { return ''; }
  try { own = new URL(`http://${ownHost}`).hostname.toLowerCase(); } catch { /* no Host header */ }
  if (!host || host === own) return '';
  return host.replace(/^www\./, '').slice(0, 100);
}

/**
 * With "use for the website" on (Settings › Analytics), the view also goes
 * to the configured Umami or Rybbit, from the server as the admin app's
 * events do: the page path, the visitor's user agent and address, nothing
 * from the page itself. Do Not Track and Global Privacy Control are honoured
 * as there. The public pages still run no script.
 */
let forwardsUnderWay = 0;

async function forwardPageView({ slug, userAgent, ip, gpc, dnt }) {
  if (forwardsUnderWay >= MAX_FORWARDS) {
    logger.debug('Website page view not forwarded: too many forwards under way');
    return;
  }
  forwardsUnderWay += 1;
  try {
    await forwardOne({ slug, userAgent, ip, gpc, dnt });
  } finally {
    forwardsUnderWay -= 1;
  }
}

async function forwardOne({ slug, userAgent, ip, gpc, dnt }) {
  const chosen = await getAppSetting('analytics_website_forward', false);
  if (chosen !== true && chosen !== 'true') return;
  if (await trackers.optedOut({ gpc, dnt })) return;
  const upstream = await trackers.resolveUpstream();
  if (!upstream) return;
  let hostname = '';
  try { hostname = new URL(await getFrontendBaseUrl()).hostname; } catch { /* no public origin known */ }
  await trackers.forwardEvent(upstream, {
    type: 'pageview', path: `/${slug || ''}`, language: '', screenWidth: 0, screenHeight: 0,
  }, { userAgent, ip, hostname });
}

/**
 * Count one view of `slug` ('' = home), and forward it when chosen. Never
 * throws and is not awaited by the response: a lost count is better than a
 * slower page.
 */
async function recordPageView({ slug, userAgent, referer, host, ip, gpc, dnt }) {
  if (isBot(userAgent)) return;
  // Settings › General › "Enable Analytics" is the one switch for all of it:
  // off, the website neither counts nor forwards.
  try {
    if (!parseBooleanInput(await getAppSetting('general_enable_analytics', true), true)) return;
  } catch (error) {
    logger.debug('Website page view not counted', { error: error.message });
    return;
  }
  forwardPageView({ slug, userAgent, ip, gpc, dnt })
    .catch((error) => logger.debug('Website page view not forwarded', { error: error.message }));
  const day = new Date().toISOString().slice(0, 10);
  const row = {
    day,
    page: String(slug || '').slice(0, 80),
    referrer: referrerDomain(referer, host),
    device: deviceClass(userAgent),
  };
  try {
    await purgeOldRows(day);
    if (row.referrer && !(await referrerCountedToday(day, row.referrer))) row.referrer = 'other';
    await db('website_page_views').insert({ ...row, views: 1 })
      .onConflict(['day', 'page', 'referrer', 'device'])
      .merge({ views: db.raw('?? + 1', ['website_page_views.views']) });
  } catch (error) {
    logger.debug('Website page view not counted', { error: error.message });
  }
}

/**
 * A referrer domain may get a row of its own today: it has one already, or
 * fewer than MAX_REFERRERS_A_DAY have.
 */
async function referrerCountedToday(day, referrer) {
  if (await db('website_page_views').where({ day, referrer }).first('id')) return true;
  const row = await db('website_page_views').where({ day }).whereNot('referrer', '').whereNot('referrer', 'other')
    .countDistinct({ n: 'referrer' }).first();
  return Number(row && row.n) < MAX_REFERRERS_A_DAY;
}

// Once a day per process: rows older than KEEP_DAYS go.
let purgedOn = '';
async function purgeOldRows(day) {
  if (purgedOn === day) return;
  purgedOn = day;
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  await db('website_page_views').where('day', '<', cutoff).del();
}

/**
 * The last `days` days of page views: per day (every day, 0 when none),
 * per page, the referring domains and the device classes in percent, each
 * added up by the database.
 */
async function pageViewStats(days) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const scope = () => db('website_page_views').where('day', '>=', since);
  const [byDay, pages, referrers, devices] = await Promise.all([
    scope().select('day').sum({ views: 'views' }).groupBy('day'),
    scope().select('page').sum({ views: 'views' }).groupBy('page').orderBy('views', 'desc').orderBy('page').limit(10),
    scope().whereNot('referrer', '').select('referrer').sum({ views: 'views' }).groupBy('referrer').orderBy('views', 'desc').orderBy('referrer').limit(10),
    scope().select('device').sum({ views: 'views' }).groupBy('device'),
  ]);
  const perDay = new Map(byDay.map((r) => [r.day, Number(r.views)]));
  const chartData = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    chartData.push({ date, views: perDay.get(date) || 0 });
  }
  const total = byDay.reduce((n, r) => n + Number(r.views), 0);
  const perDevice = new Map(devices.map((r) => [r.device, Number(r.views)]));
  const share = (device) => (total ? Math.round(((perDevice.get(device) || 0) / total) * 100) : 0);
  return {
    chartData,
    topPages: pages.map((r) => ({ page: r.page, views: Number(r.views) })),
    referrers: referrers.map((r) => ({ domain: r.referrer, views: Number(r.views) })),
    devices: { desktop: share('desktop'), mobile: share('mobile'), tablet: share('tablet') },
    totals: { views: total },
  };
}

module.exports = {
  recordPageView, referrerDomain, pageViewStats, NOT_FOUND_PAGE,
  _internal: { forgetPurge: () => { purgedOn = ''; } },
};
