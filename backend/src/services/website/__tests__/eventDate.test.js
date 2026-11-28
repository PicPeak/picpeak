/**
 * A featured gallery's date (issue 2618). On PostgreSQL node-pg reads a
 * `date` column as local midnight; east of UTC that instant is the previous
 * day in UTC, so the card must format the calendar date, not the instant.
 */
const path = require('path');
const { execFileSync } = require('child_process');

// A jest worker cannot change its own time zone (process.env there is a
// copy), so the page is rendered in a child node with TZ set.
const PROBE = `
const { renderPage } = require('./renderer');
const { normalizeDocument } = require('./document');
const day = new Date(2026, 5, 1);
const { document } = normalizeDocument({ pages: [{ id: 'h', slug: 'home', title: 'Home', isHome: true, blocks: [{ type: 'featuredGalleries', galleries: [{ id: 5 }] }] }] });
const html = renderPage({
  document, page: document.pages[0], preview: false, locale: 'en',
  branding: { companyName: 'S', colors: {} },
  theme: { background: '#fff', text: '#111', accent: '#333', muted: '#666', surface: '#fafafa', border: '#eee', buttonStyle: 'solid', radius: 'md' },
  fonts: {}, photos: new Map(), assets: new Map(), covers: new Map(), packages: new Map(), booking: { enabled: false },
  events: new Map([[5, { id: 5, slug: 'g', event_name: 'G', event_date: day }]]),
  legalLinks: [], baseUrl: '', robots: '', customCss: '', sanitizeCustomHtml: (h) => h,
});
process.stdout.write('PROBE:' + JSON.stringify({ instant: day.toISOString(), html }));
`;

const renderIn = (zone) => {
  const out = execFileSync(process.execPath, ['-e', PROBE], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TZ: zone, JWT_SECRET: process.env.JWT_SECRET || 'renderer-test-secret-0123456789abcdef' },
    encoding: 'utf8',
  });
  return JSON.parse(out.slice(out.lastIndexOf('PROBE:') + 6));
};

test('a local-midnight Date from PostgreSQL shows its own calendar day', () => {
  const { instant, html } = renderIn('Europe/Berlin');
  // The zone took effect: local midnight there is the evening before in UTC.
  expect(instant).toBe('2026-05-31T22:00:00.000Z');
  expect(html).toContain('1 June 2026');
  expect(html).not.toContain('31 May 2026');
});
