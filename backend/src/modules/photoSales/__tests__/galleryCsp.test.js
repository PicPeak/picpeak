const fs = require('fs');
const path = require('path');

const NGINX_CONF = fs.readFileSync(path.join(__dirname, '../../../../../frontend/nginx.conf'), 'utf8');

/** A CSP header value as { 'script-src': Set, … }. */
function parsePolicy(value) {
  const policy = {};
  for (const directive of value.split(';').map((d) => d.trim()).filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/);
    policy[name] = new Set(sources);
  }
  return policy;
}

/** The literal CSP of the first nginx block whose header matches `opening`. */
function nginxPolicy(opening) {
  const block = NGINX_CONF.slice(NGINX_CONF.indexOf(opening));
  return parsePolicy(block.match(/add_header Content-Security-Policy "([^"]+)"/)[1]);
}

describe('hosted checkout gallery CSP', () => {
  it('keeps gallery and ordinary SPA policies identical without third-party cart scripts', () => {
    expect(nginxPolicy('location @gallery_spa {')).toEqual(nginxPolicy('location = /index.html {'));
    expect(NGINX_CONF).not.toMatch(/unsafe-eval|snipcart\.com/);
  });
});
