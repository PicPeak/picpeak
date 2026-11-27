/**
 * The website's page views (issue 2618), counted server-side: per day, page,
 * referrer domain and device class, nothing else. No cookies, no script, no
 * address or user agent stored; crawlers and tools are not counted.
 */
const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const { isBot, deviceClass } = require('../../utils/userAgentClass');

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
 * Count one view of `slug` ('' = home). Never throws and is not awaited by
 * the response: a lost count is better than a slower page.
 */
async function recordPageView({ slug, userAgent, referer, host }) {
  if (isBot(userAgent)) return;
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
