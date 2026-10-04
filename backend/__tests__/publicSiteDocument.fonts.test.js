/**
 * The landing page must not load Inter from Google Fonts.
 *
 * buildPublicSiteDocument in server.js linked fonts.googleapis.com long after
 * the SPA (frontend/src/index.css) and the gallery themes had moved to the
 * self-hosted /fonts mount — so every visit to `/` still leaked the visitor's
 * IP to Google. The function is private to server.js, which cannot be
 * required under jest (it probes the database engine and wires every
 * service at require time), so this pins the template at source level, the
 * same way apiRateLimitGate.test.js pins the gate's registration depth.
 */
const fs = require('fs');
const path = require('path');

const backendDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(backendDir, 'server.js'), 'utf8');

const start = source.indexOf('const PUBLIC_SITE_FONT_FACES');
const end = source.indexOf('async function handlePublicSiteRequest');
const section = source.slice(start, end);
const handler = source.slice(end, source.indexOf('\n}\n', end));

describe('buildPublicSiteDocument — fonts', () => {
  it('finds the font-face block and the document template', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(section).toContain('function buildPublicSiteDocument');
  });

  it('no longer references Google Fonts anywhere in the template', () => {
    expect(section).not.toMatch(/googleapis|gstatic/);
  });

  it('declares the self-hosted Inter weights inline, swapped in like the SPA', () => {
    for (const weight of [400, 600, 700]) {
      expect(section).toContain(`font-weight: ${weight}`);
      expect(section).toContain(`url('/fonts/Inter/${weight}.woff2') format('woff2')`);
    }
    expect(section).toContain('font-display: swap');
    expect(section).toContain('<style>${PUBLIC_SITE_FONT_FACES}</style>');
  });

  it('validates the rendered document, so a template change busts cached copies', () => {
    // payload.etag hashes settings only; a client that cached the Google
    // Fonts version would otherwise get 304 forever.
    expect(handler).not.toContain("req.headers['if-none-match'] === payload.etag");
    expect(handler).toMatch(/createHash\('sha1'\)\.update\(document\)/);
    expect(handler).toContain("res.setHeader('ETag', etag)");
  });

  it('points at files the /fonts mount actually ships', () => {
    for (const weight of [400, 600, 700]) {
      expect(fs.existsSync(path.join(backendDir, 'assets/fonts/Inter', `${weight}.woff2`))).toBe(true);
    }
  });
});
