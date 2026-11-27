/**
 * What a user agent string says, roughly: a crawler or tool (not a person),
 * and a device class. Used by the website's page-view counting (issue 2618),
 * which keeps nothing else of it.
 */

// Crawlers, link previews, monitors, headless browsers and HTTP libraries.
const NOT_A_PERSON = new RegExp([
  'bot\\b', 'bot/', 'crawl', 'spider', 'slurp', 'facebookexternalhit', 'facebot', 'embedly', 'whatsapp',
  'telegram', 'discord', 'skypeuripreview', 'preview', 'headless', 'lighthouse', 'pagespeed', 'phantomjs',
  'curl/', 'wget/', 'python-', 'go-http-client', 'java/', 'okhttp', 'axios/', 'node-fetch', 'undici',
  'httpclient', 'libwww', 'monitor', 'uptime', 'pingdom', 'scrapy', 'feedfetcher', 'validator',
].join('|'), 'i');

/** A crawler, a tool, or no user agent at all. */
function isBot(userAgent) {
  return !userAgent || NOT_A_PERSON.test(userAgent);
}

/** 'mobile', 'tablet' or 'desktop'. Android without "Mobile" is a tablet. */
function deviceClass(userAgent) {
  const ua = String(userAgent || '');
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'mobile';
  return 'desktop';
}

module.exports = { isBot, deviceClass };
