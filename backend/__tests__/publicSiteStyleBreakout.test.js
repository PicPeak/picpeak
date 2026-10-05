/**
 * The public landing page interpolates a generated stylesheet — theme palette
 * custom properties, the base CSS and the operator's custom CSS — into a raw
 * <style> element. The HTML parser ends that element at the first `</style`
 * it meets, regardless of CSS structure, so a `</style>` stored through the
 * `settings.edit` theme or general-settings endpoints turned the bytes after
 * it into document markup on the unauthenticated origin (a meta refresh, a
 * fake login form). sanitizeCss stripped @import and javascript: but kept `<`.
 *
 * This boots the real server.js app (SERVE_FRONTEND=false mounts `/` on
 * handlePublicSiteRequest alone) with publicSiteService mocked, so the
 * payload reaches composeInlineStyles exactly as a malicious row would.
 *
 * Scanner findings fb8142a9 and 75f270b2.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

process.env.SERVE_FRONTEND = 'false';

jest.mock('../src/services/publicSiteService', () => ({
  getPublicSitePayload: jest.fn(),
  clearPublicSiteCache: jest.fn(),
  getDefaultPublicSitePayload: jest.fn(),
  getRawPublicSiteSettings: jest.fn(),
}));

const { getPublicSitePayload } = require('../src/services/publicSiteService');

const PALETTE = {
  primary: '#16a34a', accent: '#0f766e', background: '#f4fbf6', text: '#0f172a',
  surface: '#ffffff', elevated: '#f5f5f5', border: '#e5e5e5', mutedText: '#737373',
};

function payloadWith(overrides = {}) {
  return {
    enabled: true,
    html: '<p>Welcome</p>',
    css: '',
    baseCss: '',
    title: 'Studio',
    branding: { companyName: 'Studio', colors: { ...PALETTE } },
    etag: 'W/"test"',
    ...overrides,
  };
}

let app;

beforeAll(() => {
  // jest.setup.js's beforeAll sets an 11-char JWT_SECRET; validateEnvironment
  // (run at server.js require time) exits the process below 32 chars.
  process.env.JWT_SECRET = 'public-site-style-breakout-test-secret-0123456789';
  process.env.PICPEAK_EVIDENCE_KEY = 'a'.repeat(64);
  process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-style-breakout-'));
  process.env.TEST_DATABASE_PATH = path.join(process.env.STORAGE_PATH, 'db.sqlite');
  app = require('../server');
});

async function render(payload) {
  getPublicSitePayload.mockResolvedValue(payload);
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  return res.text;
}

function styleElementCount(html) {
  return (html.match(/<\/style/gi) || []).length;
}

describe('public site <style> element cannot be closed from settings data', () => {
  // How many <style> elements the template itself emits, taken from a render
  // with harmless settings rather than hard-coded: the document may carry
  // more than one (font faces, the generated stylesheet), and what matters
  // is that settings data cannot add another.
  let templateStyles;
  beforeAll(async () => {
    templateStyles = styleElementCount(await render(payloadWith({ css: 'a{color:red}' })));
    expect(templateStyles).toBeGreaterThan(0);
  });

  it('custom CSS carrying </style> stays inside the stylesheet', async () => {
    const html = await render(payloadWith({
      css: 'a{color:red}</style><meta http-equiv="refresh" content="0;url=https://evil.example"><style>',
    }));
    expect(html).not.toContain('<meta http-equiv="refresh"');
    expect(styleElementCount(html)).toBe(templateStyles);
    expect(html).toContain('\\3c /style>\\3c meta http-equiv="refresh"');
  });

  it.each([
    ['upper case', '</STYLE>', '<form action="https://evil.example">'],
    ['mixed case with whitespace', '</StYlE >', '<base href="https://evil.example/">'],
    ['no closing bracket', '</style ', '<img src=x onerror=alert(1)>'],
  ])('%s terminator in custom CSS', async (_label, terminator, markup) => {
    const html = await render(payloadWith({ css: `a{}${terminator}${markup}` }));
    expect(html).not.toContain(markup);
    expect(styleElementCount(html)).toBe(templateStyles);
  });

  it('a palette value carrying </style> is neutralised at the sink even when the service let it through', async () => {
    const colors = {
      ...PALETTE,
      primary: 'red;}</style><meta http-equiv="refresh" content="0;url=https://evil.example"><style>:root{--x:',
    };
    const html = await render(payloadWith({ branding: { companyName: 'Studio', colors } }));
    expect(html).not.toContain('<meta http-equiv="refresh"');
    expect(styleElementCount(html)).toBe(templateStyles);
  });

  it('every palette slot is covered', async () => {
    for (const slot of Object.keys(PALETTE)) {
      const colors = { ...PALETTE, [slot]: '#fff</style><script>alert(1)</script>' };
      const html = await render(payloadWith({ branding: { companyName: 'Studio', colors } }));
      expect(html).not.toContain('<script>');
      expect(styleElementCount(html)).toBe(templateStyles);
    }
  });

  it('leaves ordinary CSS — child combinators included — readable', async () => {
    const css = '.nav > a { color: var(--brand-primary); }\n.hero::after { content: "→"; }';
    const html = await render(payloadWith({ css }));
    expect(html).toContain(css);
    expect(html).toContain('--brand-primary: #16a34a;');
  });
});
