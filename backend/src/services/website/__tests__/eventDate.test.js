/**
 * A featured gallery's date (issue 2618). On PostgreSQL node-pg reads a
 * `date` column as local midnight; east of UTC that instant is the previous
 * day in UTC, so the card must format the calendar date, not the instant.
 * Runs with TZ=Europe/Berlin set before anything reads the clock.
 */
process.env.TZ = 'Europe/Berlin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'renderer-test-secret-0123456789abcdef';

const { renderPage } = require('../renderer');
const { normalizeDocument } = require('../document');

test('a local-midnight Date from PostgreSQL shows its own calendar day', () => {
  expect(new Date(2026, 5, 1).toISOString()).toBe('2026-05-31T22:00:00.000Z');
  const { document } = normalizeDocument({ pages: [{ id: 'h', slug: 'home', title: 'Home', isHome: true, blocks: [{ type: 'featuredGalleries', galleries: [{ id: 5 }] }] }] });
  const html = renderPage({
    document, page: document.pages[0], preview: false, locale: 'en',
    branding: { companyName: 'S', colors: {} },
    theme: { background: '#fff', text: '#111', accent: '#333', muted: '#666', surface: '#fafafa', border: '#eee', buttonStyle: 'solid', radius: 'md' },
    fonts: {}, photos: new Map(), assets: new Map(), covers: new Map(), packages: new Map(), booking: { enabled: false },
    events: new Map([[5, { id: 5, slug: 'g', event_name: 'G', event_date: new Date(2026, 5, 1) }]]),
    legalLinks: [], baseUrl: '', robots: '', customCss: '', sanitizeCustomHtml: (h) => h,
  });
  expect(html).toContain('1 June 2026');
  expect(html).not.toContain('31 May 2026');
});
