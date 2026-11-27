/**
 * Website page views (issue 2618) count people, not crawlers, and keep only a
 * rough device class of the user agent.
 */
const { isBot, deviceClass } = require('../../src/utils/userAgentClass');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

test.each([
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
  'curl/8.4.0', 'python-requests/2.31', 'Wget/1.21', 'Go-http-client/1.1',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36 Chrome-Lighthouse',
  '',
])('a crawler, tool or missing user agent is not counted: %s', (ua) => {
  expect(isBot(ua)).toBe(true);
});

test.each([IPHONE, IPAD, ANDROID_TABLET, DESKTOP])('a browser is counted: %s', (ua) => {
  expect(isBot(ua)).toBe(false);
});

test('device class: phone, tablet or desktop', () => {
  expect(deviceClass(IPHONE)).toBe('mobile');
  expect(deviceClass(IPAD)).toBe('tablet');
  expect(deviceClass(ANDROID_TABLET)).toBe('tablet');
  expect(deviceClass(DESKTOP)).toBe('desktop');
});
