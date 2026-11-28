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
          { type: 'hero', buttonTarget: { kind: 'url', url: 'javascript:alert(1)' }, image: { source: 'asset', id: '../../x' } },
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
    expect(hero.buttonTarget).toBeNull();
    expect(hero.image).toBeNull();
  });

  test('a block button leads where a menu item can: a page, a block, booking, a legal page or an address', () => {
    const blocks = (targets) => targets.map((buttonTarget, i) => ({ type: ['hero', 'imageText', 'pricing'][i % 3], buttonLabel: 'Go', buttonTarget }));
    const targets = [
      { kind: 'page', pageId: 'about' }, { kind: 'anchor', pageId: 'home', blockId: 'contact' }, { kind: 'booking' },
      { kind: 'legal', slug: 'impressum' }, { kind: 'url', url: 'https://x.example/' }, { kind: 'url', url: 'mailto:hi@x.example' },
    ];
    const { document } = normalizeDocument({ pages: [page({ blocks: blocks(targets) })] });
    expect(document.pages[0].blocks.map((b) => b.buttonTarget)).toEqual(targets);
    // The address a button used to store is no field of the block.
    expect(document.pages[0].blocks.every((b) => !('buttonUrl' in b))).toBe(true);
  });

  test('a button link stored as an address keeps leading there', () => {
    const { document } = normalizeDocument({ pages: [page({ blocks: [
      { type: 'hero', buttonLabel: 'Go', buttonUrl: '/portfolio' },
      { type: 'pricing', buttonLabel: 'Ask', buttonUrl: '#b-contact' },
      { type: 'imageText', buttonLabel: 'Bad', buttonUrl: 'javascript:alert(1)' },
    ] })] });
    expect(document.pages[0].blocks.map((b) => b.buttonTarget)).toEqual([
      { kind: 'url', url: '/portfolio' }, { kind: 'url', url: '#b-contact' }, null,
    ]);
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

describe('page cache', () => {
  const { cacheGeneration, getCached, setCached, clearWebsiteCache } = require('../cache');
  test('keeps a miss apart from no entry', () => {
    clearWebsiteCache();
    expect(getCached('page:nope')).toBeUndefined();
    setCached('page:nope', null, cacheGeneration());
    expect(getCached('page:nope')).toBeNull();
    clearWebsiteCache();
    expect(getCached('page:nope')).toBeUndefined();
  });

  test('a value from before a clear is not stored', () => {
    const startedAt = cacheGeneration();
    clearWebsiteCache();
    setCached('page:old', { status: 200 }, startedAt);
    expect(getCached('page:old')).toBeUndefined();
  });
});

describe('limits are refused, not cut', () => {
  const codes = (doc) => normalizeDocument(doc).errors.map((e) => e.code);
  const blocks = (n) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, type: 'spacer' }));

  test('a page with more than 60 blocks', () => {
    expect(codes({ pages: [page({ blocks: blocks(60) })] })).toEqual([]);
    expect(codes({ pages: [page({ blocks: blocks(61) })] })).toEqual(['TOO_MANY_BLOCKS']);
  });

  test('more than 30 pages', () => {
    const pages = Array.from({ length: 31 }, (_, i) => page({ id: `p${i}`, slug: `p-${i}`, isHome: i === 0 }));
    expect(codes({ pages })).toEqual(['TOO_MANY_PAGES']);
  });

  test('too many images, items, galleries or packages in a block', () => {
    const images = (n) => Array.from({ length: n }, (_, i) => ({ source: 'photo', id: i + 1 }));
    expect(codes({ pages: [page({ blocks: [{ type: 'gallery', images: images(61) }] })] })).toEqual(['TOO_MANY_ITEMS']);
    expect(codes({ pages: [page({ blocks: [{ type: 'instagram', images: images(13) }] })] })).toEqual(['TOO_MANY_ITEMS']);
    expect(codes({ pages: [page({ blocks: [{ type: 'testimonials', items: Array.from({ length: 25 }, () => ({ quote: 'q' })) }] })] })).toEqual(['TOO_MANY_ITEMS']);
    expect(codes({ pages: [page({ blocks: [{ type: 'pricing', packageIds: Array.from({ length: 13 }, (_, i) => i + 1) }] })] })).toEqual(['TOO_MANY_ITEMS']);
  });

  test('text over its length', () => {
    expect(codes({ pages: [page({ blocks: [{ type: 'text', heading: 'x'.repeat(200) }] })] })).toEqual([]);
    const errors = normalizeDocument({ pages: [page({ blocks: [{ id: 't', type: 'text', heading: 'x'.repeat(201) }] })] }).errors;
    expect(errors).toEqual([expect.objectContaining({ code: 'TEXT_TOO_LONG', field: 'heading', max: 200, blockId: 't' })]);
    expect(codes({ pages: [page({ blocks: [{ type: 'customHtml', html: 'x'.repeat(100 * 1024 + 1) }] })] })).toEqual(['TEXT_TOO_LONG']);
    // The settings page's stylesheet limit plus the template's base CSS.
    const { MAX_CSS_SIZE } = require('../../../utils/cssSanitizer');
    const { DEFAULT_PUBLIC_SITE_CSS } = require('../../../constants/publicSiteDefaults');
    const max = MAX_CSS_SIZE + DEFAULT_PUBLIC_SITE_CSS.length + 2;
    expect(codes({ pages: [page()], customCss: 'x'.repeat(max) })).toEqual([]);
    expect(codes({ pages: [page()], customCss: 'x'.repeat(max + 1) })).toEqual(['TEXT_TOO_LONG']);
  });
});

test('booleans sent as strings mean what they say', () => {
  const { document } = normalizeDocument({
    pages: [
      page({ isHome: 'true' }),
      page({ id: 'p2', slug: 'b', hidden: 'true', inNav: 'false', blocks: [
        { type: 'pricing', showPrices: 'false' },
        { type: 'contact', showPhone: 'false', showDate: '1' },
        { type: 'spacer', divider: '0' },
      ] }),
    ],
  });
  expect(document.pages[1]).toMatchObject({ hidden: true, isHome: false });
  // "Show in the menu" off: the menu made from the pages leaves it out.
  expect(document.menu.items.map((item) => item.id)).toEqual(['p1']);
  const [pricing, contact, spacer] = document.pages[1].blocks;
  expect(pricing.showPrices).toBe(false);
  expect(contact).toMatchObject({ showPhone: false, showDate: true });
  expect(spacer.divider).toBe(false);
});

test('a draft keeps a testimonial that is not finished yet', () => {
  const { document, errors } = normalizeDocument({ pages: [page({ blocks: [{ type: 'testimonials', items: [{ author: 'Lea' }, { quote: 'Lovely', author: 'Ben' }, {}] }] })] });
  expect(errors).toEqual([]);
  expect(document.pages[0].blocks[0].items).toEqual([
    { id: expect.any(String), quote: '', author: 'Lea', role: '', image: null },
    { id: expect.any(String), quote: 'Lovely', author: 'Ben', role: '', image: null },
    { id: expect.any(String), quote: '', author: '', role: '', image: null },
  ]);
});
