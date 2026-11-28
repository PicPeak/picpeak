/**
 * Website builder pages behind nginx (issue 2618): `/` and the page location
 * keep the backend's stricter policy for a website page (no scripts, no
 * framing) instead of nginx's site policy, keep the other security headers,
 * and are compressed also behind an outer proxy, and a page whose address
 * starts like a static path (/uploads-guide) still reaches the website
 * location. Checked against the config text; `nginx -t` and a stub-backend
 * run verified the behaviour.
 */
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.resolve(__dirname, '../../../frontend/nginx.conf'), 'utf8');

function block(opening) {
  const start = conf.indexOf(opening);
  expect(start).toBeGreaterThan(-1);
  return conf.slice(start, conf.indexOf('\n    }\n', start));
}

test('a website page keeps the policy the backend sent; anything else gets the site policy', () => {
  const map = conf.match(/map \$upstream_http_content_security_policy \$picpeak_site_csp \{([\s\S]*?)\n\}/);
  expect(map).not.toBeNull();
  expect(map[1]).toContain('default $picpeak_csp;');
  // The one regex entry, evaluated as nginx would (PCRE, case-sensitive).
  const entry = map[1].match(/"~([^"]+)" \$upstream_http_content_security_policy;/);
  expect(entry).not.toBeNull();
  const kept = (policy) => new RegExp(entry[1]).test(policy);
  const { websiteCsp } = require('../../src/services/website/captcha');
  // Every page policy the website sends: no script, or a captcha's own.
  expect(kept(websiteCsp())).toBe(true);
  expect(kept(websiteCsp('friendly'))).toBe(true);
  expect(kept(websiteCsp('recaptcha'))).toBe(true);
  // Anything that would run the site's own or inline script is not.
  expect(kept('default-src \'self\'; script-src \'self\'')).toBe(false);
  expect(kept('default-src \'self\'; script-src https://cdn.example/ \'unsafe-inline\'; base-uri \'none\'')).toBe(false);
  expect(kept('default-src \'self\'; script-src \'self\' https://www.google.com')).toBe(false);
  expect(kept('default-src \'self\'; script-src https:; base-uri \'none\'')).toBe(false);
});

test.each([['location = / {'], ['location ~ "^/(?!(?:']])('%s carries the full header set and compresses', (opening) => {
  const body = block(opening);
  expect(body).toContain('add_header Content-Security-Policy $picpeak_site_csp always;');
  for (const header of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    expect(body).toContain(`add_header ${header} `);
  }
  expect(body).toContain('gzip_proxied any;');
});

// nginx's choice of location for a path: an exact match; else the longest
// prefix, final when it is `^~`; else the first regex that matches, in
// order; else that longest prefix. Named locations are not chosen by path.
function locations() {
  return [...conf.matchAll(/^\s*location\s+(=|\^~|~\*|~)?\s*("(?:[^"\\]|\\.)*"|\S+)\s*\{/gm)].map(([, mod = '', raw]) => ({
    mod, path: raw.startsWith('"') ? raw.slice(1, -1) : raw, label: `${mod ? `${mod} ` : ''}${raw}`,
  })).filter((l) => !l.path.startsWith('@'));
}
function resolve(uri) {
  const all = locations();
  const exact = all.find((l) => l.mod === '=' && l.path === uri);
  if (exact) return exact.label;
  const prefix = all.filter((l) => (l.mod === '' || l.mod === '^~') && uri.startsWith(l.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (prefix && prefix.mod === '^~') return prefix.label;
  const regex = all.find((l) => (l.mod === '~' || l.mod === '~*') && new RegExp(l.path, l.mod === '~*' ? 'i' : '').test(uri));
  if (regex) return regex.label;
  return prefix ? prefix.label : null;
}

test('a website page whose address starts like a static path still reaches the website location (its own, stricter policy)', () => {
  const website = locations().find((l) => l.path.startsWith('^/(?!(?:')).label;
  for (const uri of ['/uploads-guide', '/fonts-and-colours', '/photos-tips', '/thumbnails-and-more', '/api-docs', '/health-check', '/static-shots', '/assets-list']) {
    expect([uri, resolve(uri)]).toEqual([uri, website]);
  }
  // The static and proxied paths keep their own locations.
  expect(resolve('/uploads/logos/logo.png')).toBe('^~ /uploads/');
  expect(resolve('/fonts/Inter/400.woff2')).toBe('^~ /fonts/');
  expect(resolve('/photos/1/2')).toBe('/photos');
  expect(resolve('/api/public/settings')).toBe('/api');
  expect(resolve('/site-media/p1.x/640')).toBe('^~ /site-media/');
  // (A bare /uploads or /fonts, which nothing requests, gets nginx's 301 to
  // the slash form of a proxied prefix location; checked in a stub run.)
});

test('a plain 404 gets the SPA shell; only the website\'s marked not-found page passes as a 404', () => {
  const website = block('location ~ "^/(?!(?:');
  // Any 404 the backend answers here gets the shell (an older backend, a
  // path nothing answers), as do nginx's own failures.
  expect(website).toMatch(/proxy_intercept_errors on;/);
  expect(website).toMatch(/error_page 404 502 503 504 = \/index\.html;/);
  // The backend hands a path back with X-Accel-Redirect (server.js).
  expect(website).toContain('proxy_set_header X-PicPeak-Spa-Fallback "1";');
  const spa = block('location = /__spa {');
  expect(spa).toContain('internal;');
  // Through the shell's own location, so its headers (no-cache, noindex,
  // the security set) are defined in exactly one place.
  expect(spa).toContain('rewrite ^ /index.html last;');
  expect(spa).not.toMatch(/try_files|add_header|root /);
  expect(block('location = /index.html {')).toContain('add_header X-Robots-Tag "noindex" always;');
  // The website's own not-found page: internal only, asked without the
  // mark, its 404 not intercepted, the website's policy and headers kept.
  const notFound = block('location ^~ /__website/ {');
  expect(notFound).toContain('internal;');
  expect(notFound).toContain('rewrite ^/__website(/.*)$ $1 break;');
  expect(notFound).not.toContain('X-PicPeak-Spa-Fallback');
  expect(notFound).toMatch(/error_page 502 503 504 = \/index\.html;/);
  expect(notFound).not.toMatch(/error_page[^;]*\b404\b/);
  expect(notFound).toContain('add_header Content-Security-Policy $picpeak_site_csp always;');
  expect(notFound).toContain('add_header X-Frame-Options "SAMEORIGIN" always;');
});
