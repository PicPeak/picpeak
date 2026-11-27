/**
 * Website builder renderer (issue 2618): the public markup and its security
 * rules, without a database.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'renderer-test-secret-0123456789abcdef';

const { renderPage, richText, srcsetFor } = require('../renderer');
const { normalizeDocument } = require('../document');
const { sanitizeHtmlPayload, applyBrandTokens } = require('../../publicSiteService');

const BRANDING = {
  companyName: 'Studio <Lumen>',
  companyTagline: 'Weddings & portraits',
  supportEmail: 'hello@example.com',
  logoUrl: '/uploads/logos/logo.png',
  footerText: null,
  colors: {},
};

function render(pages, over = {}) {
  const { document } = normalizeDocument({ pages, ...(over.doc || {}) });
  const page = document.pages.find((p) => p.id === (over.pageId || document.pages[0].id));
  return renderPage({
    document,
    page,
    preview: false,
    locale: 'en',
    branding: BRANDING,
    theme: { background: '#ffffff', text: '#111111', accent: '#7c3aed', muted: '#666666', surface: '#fafafa', border: '#e5e5e5', buttonStyle: 'solid', radius: 'md' },
    fonts: { body: null, heading: null },
    photos: new Map(),
    assets: new Map(),
    events: new Map(),
    covers: new Map(),
    packages: new Map(),
    booking: { enabled: false },
    legalLinks: [{ href: '/impressum', label: 'Impressum' }],
    baseUrl: 'https://studio.example',
    robots: '',
    customCss: '',
    sanitizeCustomHtml: (html) => applyBrandTokens(sanitizeHtmlPayload(html), BRANDING),
    ...over.ctx,
  });
}

const home = (blocks, extra = {}) => ({ id: 'home', slug: 'home', title: 'Home', isHome: true, blocks, ...extra });

describe('text is escaped everywhere', () => {
  test('block fields cannot inject markup', () => {
    const payload = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>';
    const html = render([home([
      { type: 'hero', heading: payload, subheading: payload, buttonLabel: payload, buttonUrl: '/x' },
      { type: 'text', heading: payload, body: payload },
      { type: 'testimonials', items: [{ quote: payload, author: payload, role: payload }] },
      { type: 'contact', heading: payload, intro: payload, submitLabel: payload, successMessage: payload },
    ], { title: payload, navLabel: payload, seo: { title: payload, description: payload } })]);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/onerror=alert\(1\)>/);
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    // Branding is escaped too.
    expect(html).toContain('Studio &lt;Lumen&gt;');
  });

  test('inline formatting only produces strong, em and safe links', () => {
    expect(richText('**bold** and *it* [site](https://a.example) [bad](javascript:alert(1))'))
      .toBe('<p><strong>bold</strong> and <em>it</em> <a href="https://a.example" rel="noopener noreferrer">site</a> [bad](javascript:alert(1))</p>');
    expect(richText('a\nb\n\nc')).toBe('<p>a<br>b</p><p>c</p>');
    expect(richText('[x](https://a.example/"onmouseover=alert(1))')).not.toMatch(/"onmouseover/);
  });
});

test('buttons never carry a script URL', () => {
  const html = render([home([{ type: 'hero', heading: 'H', buttonLabel: 'Go', buttonUrl: 'javascript:alert(1)' }])]);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toContain('>Go</a>');
});

test('the custom HTML block goes through the public-site sanitiser', () => {
  const html = render([home([{ type: 'customHtml', html: '<p onclick="x()">Hi {{company_name}}</p><script>alert(1)</script><iframe src="https://evil"></iframe><a href="javascript:alert(1)">x</a>' }])]);
  expect(html).toContain('<p>Hi Studio &lt;Lumen&gt;</p>');
  expect(html).not.toMatch(/<script>alert|onclick|<iframe|javascript:/);
});

test('custom CSS cannot close the style element', () => {
  const html = render([home([])], { ctx: { customCss: 'body{color:red}</style><script>alert(1)</script>' } });
  expect(html).not.toMatch(/<\/style><script>/);
});

describe('images fail closed', () => {
  const photo = { id: 11, event_id: 3, width: 4000, height: 3000 };

  test('a picked photo that is not in the eligible set is not rendered', () => {
    const html = render([home([{ type: 'gallery', images: [{ source: 'photo', id: 11 }] }])]);
    expect(html).not.toContain('/site-media/');
  });

  test('an eligible photo is rendered as signed rendition URLs with a srcset and its size', () => {
    const html = render([home([{ type: 'gallery', images: [{ source: 'photo', id: 11, alt: 'Bride' }] }])], { ctx: { photos: new Map([[11, photo]]) } });
    expect(html).toMatch(/src="\/site-media\/p11-[0-9a-f]{10}\.[0-9a-f]{32}\/1280"/);
    expect(html).toMatch(/srcset="\/site-media\/p11-[0-9a-f]{10}\.[0-9a-f]{32}\/640 640w, \/site-media\/p11-[0-9a-f]{10}\.[0-9a-f]{32}\/1280 1280w, \/site-media\/p11-[0-9a-f]{10}\.[0-9a-f]{32}\/1920 1920w"/);
    expect(html).toContain('width="4000" height="3000"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('alt="Bride"');
    // No gallery slug, share token or original path in a public image URL.
    expect(html).not.toMatch(/\/gallery\/|\/photo\/|share/);
  });

  test('srcset widths follow the real rendition size, without duplicates', () => {
    const set = srcsetFor({ base: '/m', width: 1000, height: 1500, tiers: [640, 1280, 1920] });
    expect(set).toBe('/m/640 427w, /m/1280 853w, /m/1920 1000w');
    expect(srcsetFor({ base: '/m', width: 500, height: 400, tiers: [640, 1280, 1920] })).toBe('/m/640 500w');
  });

  test('the first hero image is preloaded and not lazy', () => {
    const html = render([home([{ type: 'hero', variant: 'overlay', heading: 'H', image: { source: 'photo', id: 11 } }])], { ctx: { photos: new Map([[11, photo]]) } });
    expect(html).toMatch(/<link rel="preload" as="image" imagesrcset="[^"]+" imagesizes="100vw" fetchpriority="high">/);
    expect(html).toMatch(/<img class="pp-hero__media"[^>]+fetchpriority="high"/);
    expect(html).toContain('<meta property="og:image" content="https://studio.example/site-media/p11-');
  });
});

test('featured galleries link by slug only and need an eligible gallery', () => {
  const event = { id: 5, slug: 'anna-ben', event_name: 'Anna & Ben', event_date: '2026-06-01', share_token: 'SECRET-TOKEN' };
  const without = render([home([{ type: 'featuredGalleries', galleries: [{ id: 5 }] }])]);
  expect(without).not.toContain('Anna');
  const html = render([home([{ type: 'featuredGalleries', galleries: [{ id: 5, text: 'A summer wedding' }] }])], { ctx: { events: new Map([[5, event]]) } });
  expect(html).toContain('href="/gallery/anna-ben"');
  expect(html).toContain('Anna &amp; Ben');
  expect(html).not.toContain('SECRET-TOKEN');
});

test('the booking block is hidden while booking is off', () => {
  const blocks = [{ type: 'booking', heading: 'Book a session', buttonLabel: 'Book' }];
  expect(render([home(blocks)])).not.toContain('Book a session');
  const html = render([home(blocks)], { ctx: { booking: { enabled: true, url: '/book' } } });
  expect(html).toContain('href="/book"');
});

test('pricing shows catalogue packages by id with a formatted price', () => {
  const html = render([home([{ type: 'pricing', heading: 'Packages', packageIds: [3, 4] }])], {
    ctx: { packages: new Map([[3, { name: 'Full day', description: 'All day', currency: 'CHF', totalMinor: 250000, items: ['Ceremony', '<b>Party</b>'] }]]) },
  });
  expect(html).toContain('Full day');
  expect(html).toMatch(/CHF\s?2[’'`,]?500/);
  expect(html).toContain('&lt;b&gt;Party&lt;/b&gt;');
});

test('the contact form posts to the public endpoint with a honeypot and the notes', () => {
  const html = render([home([{ id: 'c1', type: 'contact', showPhone: true }])]);
  expect(html).toContain('action="/api/public/website/contact"');
  expect(html).toContain('enctype="multipart/form-data"');
  expect(html).toContain('name="company_website"');
  expect(html).toContain('id="contact-sent-c1"');
  expect(html).toContain('name="phone"');
  expect(html).not.toContain('name="date"');
});

test('navigation and footer come from the visible pages; hidden pages are left out', () => {
  const html = render([
    home([]),
    { id: 'about', slug: 'about', title: 'About', blocks: [] },
    { id: 'secret', slug: 'secret', title: 'Secret', hidden: true, blocks: [] },
    { id: 'faq', slug: 'faq', title: 'FAQ', inNav: false, blocks: [] },
  ], { pageId: 'about' });
  expect(html).toContain('<a href="/about" aria-current="page">About</a>');
  expect(html).not.toContain('/secret');
  expect(html).toContain('href="/faq"'); // footer lists it
  expect(html.match(/href="\/faq"/g)).toHaveLength(1); // not in the nav
  expect(html).toContain('<a href="/impressum">Impressum</a>');
  expect(html).toContain('<link rel="canonical" href="https://studio.example/about">');
  expect(html).toContain('<title>About · Studio &lt;Lumen&gt;</title>');
});

test('the public page ships no script, the preview marks blocks and disables the form', () => {
  const pages = [home([{ id: 'c1', type: 'contact' }, { id: 't1', type: 'text', body: 'x' }])];
  const live = render(pages);
  expect(live).not.toMatch(/<script|data-block-id/);
  const preview = render(pages, { ctx: { preview: true } });
  expect(preview).toContain('data-block-id="t1"');
  expect(preview).toMatch(/<button class="pp-btn" type="submit" disabled>/);
});

test('the photo strip names the account once', () => {
  const html = render([home([{ type: 'instagram', handle: '@studio', profileUrl: 'https://www.instagram.com/studio', images: [{ source: 'photo', id: 11 }] }])], { ctx: { photos: new Map([[11, { id: 11, width: 10, height: 10 }]]) } });
  expect(html.match(/@studio/g)).toHaveLength(1);
  expect(html).toContain('>Follow →</a>');
});

test('robots directives are emitted', () => {
  expect(render([home([])], { ctx: { robots: 'noindex, nofollow' } })).toContain('<meta name="robots" content="noindex, nofollow">');
});

test('without a known public origin the canonical stays relative and no og:image is guessed', () => {
  const html = render([home([{ type: 'hero', image: { source: 'photo', id: 11 } }])], { ctx: { baseUrl: '', photos: new Map([[11, { id: 11, width: 10, height: 10 }]]) } });
  expect(html).toContain('<link rel="canonical" href="/">');
  expect(html).not.toContain('og:image');
});

test('an imported landing page keeps the --brand-* variables its CSS was written against', () => {
  const colors = { primary: '#123456', accent: '#234567', background: '#f0f0f0', text: '#111111', surface: '#fefefe', elevated: '#eeeeee', border: '#dddddd', mutedText: '#777777' };
  const html = render([home([{ type: 'customHtml', html: '<a class="button button--primary">Go</a>' }])], {
    ctx: { branding: { ...BRANDING, colors }, customCss: '.button--primary{background:var(--brand-primary)}' },
  });
  for (const [name, value] of [['primary', '#123456'], ['accent', '#234567'], ['background', '#f0f0f0'], ['text', '#111111'],
    ['surface', '#fefefe'], ['elevated', '#eeeeee'], ['border', '#dddddd'], ['muted-text', '#777777']]) {
    expect(html).toContain(`--brand-${name}: ${value};`);
  }
});

test('a testimonial without a quote is left off the page', () => {
  const html = render([home([{ type: 'testimonials', items: [{ author: 'Unfinished Lea' }, { quote: 'Lovely day', author: 'Ben' }] }])]);
  expect(html).toContain('Lovely day');
  expect(html).not.toContain('Unfinished Lea');
});
