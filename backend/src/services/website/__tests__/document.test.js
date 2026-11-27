/**
 * Website builder document (issue 2618): what an admin can store.
 */
const {
  normalizeDocument, normalizeSlug, isValidSlug, safeUrl, collectReferences,
} = require('../document');

const page = (over = {}) => ({ id: 'p1', title: 'Home', slug: 'home', blocks: [], ...over });

describe('safeUrl', () => {
  test.each([
    ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ['http://example.com', 'http://example.com'],
    ['mailto:studio@example.com', 'mailto:studio@example.com'],
    ['tel:+41 44 000 00 00', 'tel:+41440000000'],
    ['tel:+41440000000', 'tel:+41440000000'],
    ['/about', '/about'],
    ['#contact', '#contact'],
  ])('keeps %s', (input, expected) => {
    expect(safeUrl(input)).toBe(expected);
  });

  test.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    '//evil.example/path',
    '/\\evil.example',
    'https:/\\evil.example',
    'ftp://example.com',
    '#"><script>',
    'https://',
    'tel:javascript:alert(1)',
  ])('drops %s', (input) => {
    expect(safeUrl(input)).toBe('');
  });
});

describe('slugs', () => {
  test('are derived from the title and cleaned', () => {
    expect(normalizeSlug('Über uns & Preise!')).toBe('uber-uns-preise');
    expect(normalizeSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(normalizeSlug('  --a--b--  ')).toBe('a-b');
  });

  test('reserved and malformed slugs are refused', () => {
    expect(isValidSlug('about')).toBe(true);
    for (const slug of ['admin', 'api', 'gallery', 'impressum', 'site-media', 'sitemap', '', 'a/b', '..', 'A']) {
      expect(isValidSlug(slug)).toBe(false);
    }
  });

  test('a reserved, duplicate or cms-owned slug is an error the admin has to fix', () => {
    const { errors } = normalizeDocument({
      pages: [page(), page({ id: 'p2', title: 'Admin', slug: 'admin' }), page({ id: 'p3', slug: 'home' }), page({ id: 'p4', slug: 'faq' })],
    }, { reservedSlugs: ['faq'] });
    expect(errors.map((e) => e.code).sort()).toEqual(['SLUG_DUPLICATE', 'SLUG_RESERVED', 'SLUG_TAKEN_BY_CMS_PAGE']);
  });

  test('a path traversal attempt never survives as a slug', () => {
    const { document } = normalizeDocument({ pages: [page({ slug: '../../../etc/passwd' })] });
    expect(document.pages[0].slug).toBe('etc-passwd');
  });
});

describe('normalizeDocument', () => {
  test('keeps exactly one visible home page', () => {
    const { document } = normalizeDocument({
      pages: [page({ id: 'a', slug: 'a', isHome: false }), page({ id: 'b', slug: 'b', isHome: true, hidden: true }), page({ id: 'c', slug: 'c', isHome: true })],
    });
    expect(document.pages.map((p) => p.isHome)).toEqual([false, false, true]);
    // A hidden page cannot be the home page; the first visible one asked for it.
    expect(document.pages[2].hidden).toBe(false);
  });

  test('falls back to the first page as home and unhides it', () => {
    const { document } = normalizeDocument({ pages: [page({ isHome: false, hidden: true })] });
    expect(document.pages[0]).toMatchObject({ isHome: true, hidden: false });
  });

  test('drops unknown block types and fields, caps strings and lists', () => {
    const { document } = normalizeDocument({
      pages: [page({
        blocks: [
          { type: 'script', html: '<script>' },
          { type: 'text', variant: 'nope', background: 'url(x)', heading: 'x'.repeat(500), body: 'b', onclick: 'x' },
          { type: 'gallery', images: Array.from({ length: 100 }, (_, i) => ({ source: 'photo', id: i + 1 })), columns: 99 },
          { type: 'hero', buttonUrl: 'javascript:alert(1)', image: { source: 'asset', id: '../../x' } },
        ],
      })],
    });
    const [text, gallery, hero] = document.pages[0].blocks;
    expect(document.pages[0].blocks).toHaveLength(3);
    expect(text).toMatchObject({ type: 'text', variant: 'left', background: 'default' });
    expect(text.heading).toHaveLength(200);
    expect(text.onclick).toBeUndefined();
    expect(gallery.images).toHaveLength(60);
    expect(gallery.columns).toBe(3);
    expect(hero.buttonUrl).toBe('');
    expect(hero.image).toBeNull();
  });

  test('theme colours and fonts must be values, not CSS', () => {
    const { document } = normalizeDocument({
      pages: [page()],
      theme: { accent: 'red;}</style><script>', background: '#fff', text: 'rgb(1,2,3)', headingFont: 'Inter\'}body{', bodyFont: 'Playfair Display', buttonStyle: 'x' },
    });
    expect(document.theme).toEqual({ accent: null, background: '#fff', text: 'rgb(1,2,3)', headingFont: null, bodyFont: 'Playfair Display', buttonStyle: null });
  });

  test('block ids are unique within a page', () => {
    const { document } = normalizeDocument({ pages: [page({ blocks: [{ id: 'x', type: 'spacer' }, { id: 'x', type: 'spacer' }] })] });
    const ids = document.pages[0].blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
  });

  test('an empty site is an error', () => {
    expect(normalizeDocument({ pages: [] }).errors).toEqual([{ code: 'NO_PAGES' }]);
  });
});

test('collectReferences finds every image, gallery and package', () => {
  const { document } = normalizeDocument({
    pages: [page({
      seo: { image: { source: 'photo', id: 9 } },
      blocks: [
        { type: 'hero', image: { source: 'asset', id: 'a'.repeat(24) }, video: { id: 'b'.repeat(24) } },
        { type: 'gallery', images: [{ source: 'photo', id: 1 }, { source: 'photo', id: 1 }] },
        { type: 'testimonials', items: [{ quote: 'q', image: { source: 'photo', id: 2 } }] },
        { type: 'featuredGalleries', galleries: [{ id: 5 }] },
        { type: 'pricing', packageIds: [7, 7, 'x'] },
      ],
    })],
  });
  expect(collectReferences(document)).toEqual({
    photoIds: [9, 1, 2], assetIds: ['a'.repeat(24), 'b'.repeat(24)], eventIds: [5], packageIds: [7],
  });
});
