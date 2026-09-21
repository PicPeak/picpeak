/**
 * Scanner probes (/wp-login.php, /phpmyadmin/, /cgi-bin/…) used to be answered
 * with 200 and the SPA shell: nginx's `try_files … /index.html` and the Express
 * history fallback both treat any unknown path as a client-side route. PicPeak
 * has no route that looks like these, so a 200 is simply wrong — it tells the
 * scanner "something is here", and it blinds every log-based tool an operator
 * puts in front (CrowdSec's http-probing and fail2ban's 404 jails count 404s).
 *
 * Two layers serve the shell, so two layers need the rule: frontend/nginx.conf
 * for the compose stack, the Express fallback for the single-container image.
 * The source half of this file pins that they agree.
 */
const fs = require('fs');
const path = require('path');
const { isScannerProbePath } = require('../../src/utils/scannerPaths');

const repoFile = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

describe('isScannerProbePath', () => {
  it.each([
    '/wp-login.php',
    '/wp-login.php/',
    '/xmlrpc.php/',
    '/default.aspx/',
    '/xmlrpc.php',
    '/index.PHP',
    '/old/shell.php7',
    '/info.phtml',
    '/default.aspx',
    '/login.asp',
    '/manager/status.jsp',
    '/cgi-bin/luci',
    '/cgi-bin',
    '/wp-admin/',
    '/wp-content/plugins/x/readme.txt',
    '/wp-includes/wlwmanifest.xml',
    '/phpMyAdmin/',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
  ])('flags %s', (p) => {
    expect(isScannerProbePath(p)).toBe(true);
  });

  // Every client-side route the SPA owns, plus look-alikes that must survive:
  // an operator is free to publish a CMS page called "vendor" or "php".
  it.each([
    '/',
    '/admin',
    '/admin/events/12',
    '/gallery/wedding-anna-tom',
    '/gallery/wedding-anna-tom/abc123',
    '/customer',
    '/setup',
    '/impressum',
    '/datenschutz',
    '/quote/tok_123',
    '/contract/tok_123',
    '/transfer/tok_123',
    '/payment-check',
    '/vendor',
    '/php',
    '/wp-administration',
    '/cgi-binary',
    '/photos.php.jpg',
    // Known residual, kept narrow on purpose (see scannerPaths.js).
    '/wordpress/wp-admin/',
  ])('leaves %s alone', (p) => {
    expect(isScannerProbePath(p)).toBe(false);
  });
});

describe('both shell-serving layers apply the rule', () => {
  it('the Express history fallback 404s probes instead of sending the shell', () => {
    const server = repoFile('backend', 'server.js');
    const fallback = server.slice(server.indexOf('const BACKEND_OWNED'));
    expect(fallback).toMatch(/isScannerProbePath\(req\.path\)\)\s*return next\(\)/);
  });

  it('frontend/nginx.conf carries the same two patterns, ahead of the static-asset regex', () => {
    const conf = repoFile('frontend', 'nginx.conf');
    const ext = conf.indexOf('location ~* \\.(php\\d?|phtml|aspx?|jspx?|cgi)/?$ {');
    const dirs = conf.indexOf('location ~* ^/(wp-admin|wp-content|wp-includes|phpmyadmin|cgi-bin)(/|$) {');
    const statics = conf.indexOf('# Cache static assets');
    expect(ext).toBeGreaterThan(-1);
    expect(dirs).toBeGreaterThan(-1);
    // nginx takes the FIRST matching regex location, so /wp-content/x.js must
    // meet these before the static-asset block.
    expect(ext).toBeLessThan(statics);
    expect(dirs).toBeLessThan(statics);
  });
});
