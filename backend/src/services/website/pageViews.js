/**
 * The website's page views (issue 2618), counted server-side: per day, page,
 * referrer domain and device class, nothing else. No cookies, no script, no
 * address or user agent stored; crawlers and tools are not counted, and
 * nothing is counted or forwarded while analytics is off (Settings › General).
 */
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
async function forwardPageView({ slug, userAgent, ip, gpc, dnt }) {
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
  const row = {
    day: new Date().toISOString().slice(0, 10),
    page: String(slug || '').slice(0, 80),
    referrer: referrerDomain(referer, host),
    device: deviceClass(userAgent),
  };
  try {
    await db('website_page_views').insert({ ...row, views: 1 })
      .onConflict(['day', 'page', 'referrer', 'device'])
      .merge({ views: db.raw('?? + 1', ['website_page_views.views']) });
  } catch (error) {
    logger.debug('Website page view not counted', { error: error.message });
  }
}

/**
 * The last `days` days of page views: per day (every day, 0 when none),
 * per page, the referring domains and the device classes in percent.
 */
async function pageViewStats(days) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = await db('website_page_views').where('day', '>=', since).select('day', 'page', 'referrer', 'device', 'views');
  const sum = (key) => {
    const totals = new Map();
    rows.forEach((row) => totals.set(row[key], (totals.get(row[key]) || 0) + Number(row.views)));
    return totals;
  };
  const byDay = sum('day');
  const chartData = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    chartData.push({ date, views: byDay.get(date) || 0 });
  }
  const top = (totals, field, limit) => [...totals.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, views]) => ({ [field]: value, views }));
  const total = rows.reduce((n, row) => n + Number(row.views), 0);
  const devices = sum('device');
  const share = (device) => (total ? Math.round(((devices.get(device) || 0) / total) * 100) : 0);
  const referrers = sum('referrer');
  referrers.delete('');
  return {
    chartData,
    topPages: top(sum('page'), 'page', 10),
    referrers: top(referrers, 'domain', 10),
    devices: { desktop: share('desktop'), mobile: share('mobile'), tablet: share('tablet') },
    totals: { views: total },
  };
}

module.exports = { recordPageView, referrerDomain, pageViewStats };
