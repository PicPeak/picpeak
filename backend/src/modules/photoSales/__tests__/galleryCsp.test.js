const fs = require('fs');
const path = require('path');
const { withPhotoSalesSources } = require('../galleryCsp');

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

/** helmet's camelCase directives as a parsed header. */
function fromHelmet(directives) {
  const policy = {};
  for (const [name, sources] of Object.entries(directives)) {
    policy[name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)] = new Set(sources);
  }
  return policy;
}

describe('photo sales gallery CSP', () => {
  it('grants the backend-served gallery pages what nginx grants @gallery_spa', () => {
    // The site policy nginx sends on the SPA shell, as helmet directives.
    const site = nginxPolicy('location = /index.html {');
    const siteDirectives = {};
    for (const [name, sources] of Object.entries(site)) {
      siteDirectives[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = [...sources];
    }

    expect(fromHelmet(withPhotoSalesSources(siteDirectives))).toEqual(nginxPolicy('location @gallery_spa {'));
  });

  it('leaves the site directives it is given untouched', () => {
    const site = { scriptSrc: ['\'self\''], connectSrc: ['\'self\''] };
    withPhotoSalesSources(site);
    expect(site).toEqual({ scriptSrc: ['\'self\''], connectSrc: ['\'self\''] });
  });
});
