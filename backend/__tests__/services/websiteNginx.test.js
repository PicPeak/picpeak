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
  expect(map[1]).toContain('"~script-src \'none\'" $upstream_http_content_security_policy;');
  expect(map[1]).toContain('default $picpeak_csp;');
});

test.each([['location = / {'], ['location ~ "^/(?!(?:']])('%s carries the full header set and compresses', (opening) => {
  const body = block(opening);
  expect(body).toContain('add_header Content-Security-Policy $picpeak_site_csp always;');
  for (const header of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    expect(body).toContain(`add_header ${header} `);
  }
  expect(body).toContain('gzip_proxied any;');
});
