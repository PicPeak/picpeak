/**
 * Website builder pages behind nginx (issue 2618): `/` and the page location
 * keep the backend's stricter policy for a website page (no scripts, no
 * framing) instead of nginx's site policy, keep the other security headers,
 * and are compressed also behind an outer proxy. Checked against the config
 * text; `nginx -t` and a stub-backend run verified the behaviour.
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
