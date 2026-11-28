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

describe('hero video in the editor preview', () => {
  const video = { id: 'b'.repeat(24), kind: 'video', mime_type: 'video/mp4', rendition_keys: '{}' };
  const blocks = [{ type: 'hero', variant: 'overlay', heading: 'H', video: { id: 'b'.repeat(24) }, image: { source: 'photo', id: 11 } }];
  const ctx = { assets: new Map([['b'.repeat(24), video]]), photos: new Map([[11, { id: 11, width: 1600, height: 900 }]]), preview: true };

  test('plays the video when the preview may load it', () => {
    const html = render([home(blocks)], { ctx });
    expect(html).toContain('<video');
  });

  test('shows the poster and says where the video plays when the admin runs on another origin', () => {
    const html = render([home(blocks)], { ctx: { ...ctx, videoAsPoster: true } });
    expect(html).not.toContain('<video');
    expect(html).toMatch(/<img class="pp-hero__media"[^>]+src="\/site-media\/ep11-/);
    expect(html).toContain('Video plays on the published page');
  });

  test('without a poster image it shows a neutral placeholder', () => {
    const html = render([home([{ ...blocks[0], image: null }])], { ctx: { ...ctx, videoAsPoster: true } });
    expect(html).not.toContain('<video');
    expect(html).toContain('pp-hero__placeholder');
  });

  test('the published page always plays it', () => {
    const html = render([home(blocks)], { ctx: { ...ctx, preview: false, videoAsPoster: true } });
    expect(html).toContain('<video');
  });
});

describe('custom block background', () => {
  const textBlock = (over) => ({ type: 'text', id: 't1', heading: 'Hi', body: 'There', ...over });

  test('keeps only an opaque hex colour, and drops it for the other backgrounds', () => {
    const blocks = (over) => normalizeDocument({ pages: [home([textBlock(over)])] }).document.pages[0].blocks[0];
    expect(blocks({ background: 'custom', backgroundColor: '#1E3A2F' })).toMatchObject({ background: 'custom', backgroundColor: '#1e3a2f', textColor: null });
    expect(blocks({ background: 'custom', backgroundColor: '#1e3a2f', textColor: '#FFEEDD' }).textColor).toBe('#ffeedd');
    // Not a colour (or a value that could carry CSS): the page background.
    expect(blocks({ background: 'custom', backgroundColor: 'red;background:url(x)' })).toMatchObject({ background: 'default' });
    expect(blocks({ background: 'custom', backgroundColor: 'rgba(0,0,0,.2)' })).toMatchObject({ background: 'default' });
    expect(blocks({ background: 'light', backgroundColor: '#123456' })).not.toHaveProperty('backgroundColor');
  });

  test('paints the colour and picks readable text for it, unless the text colour is set', () => {
    const dark = render([home([textBlock({ background: 'custom', backgroundColor: '#1e3a2f' })])]);
    expect(dark).toMatch(/<section id="b-t1" class="[^"]*pp-custom-bg[^"]*" style="--bg:#1e3a2f;--text:#f5f5f5;/);
    const light = render([home([textBlock({ background: 'custom', backgroundColor: '#fdf6e3' })])]);
    expect(light).toMatch(/style="--bg:#fdf6e3;--text:#111111;/);
    const chosen = render([home([textBlock({ background: 'custom', backgroundColor: '#1e3a2f', textColor: '#ffcc00' })])]);
    expect(chosen).toMatch(/style="--bg:#1e3a2f;--text:#ffcc00;/);
  });
});

describe('divider block', () => {
  test('draws a thin or medium line, short or full, with its spacing', () => {
    const html = render([home([
      { type: 'divider', id: 'd1', variant: 'medium', width: 'short', spacing: 'large' },
      { type: 'divider', id: 'd2' },
    ])]);
    expect(html).toMatch(/<section id="b-d1" class="pp-block pp-divider pp-v-medium[^"]*pp-divider--short[^"]*pp-space-large[^"]*"><div class="pp-wrap"><hr class="pp-line"><\/div><\/section>/);
    // Defaults: thin, full width, medium spacing.
    expect(html).toMatch(/<section id="b-d2" class="pp-block pp-divider pp-v-thin[^"]*pp-divider--full[^"]*pp-space-medium/);
  });

  test('unknown options fall back to the defaults', () => {
    const block = normalizeDocument({ pages: [home([{ type: 'divider', variant: 'bold', width: '200%', spacing: 'huge' }])] }).document.pages[0].blocks[0];
    expect(block).toMatchObject({ type: 'divider', variant: 'thin', width: 'full', spacing: 'medium' });
  });
});

describe('rich text in the text block', () => {
  const textBlock = (over) => normalizeDocument({ pages: [home([{ type: 'text', id: 't1', ...over }])] }).document.pages[0].blocks[0];

  test('older plain text becomes the HTML it always rendered as, so the page stays the same', () => {
    const body = 'First **bold** line\nsecond [link](https://example.com) line\n\nA *new* paragraph with <script>x</script>';
    const before = require('../renderer').richText(body);
    const block = textBlock({ body });
    expect(block).toMatchObject({ format: 'html' });
    expect(block.body).toBe(before);
    expect(render([home([{ type: 'text', id: 't1', body }])])).toContain(`<div class="pp-prose">${before}</div>`);
  });

  test('HTML from the editor keeps its formatting and loses everything else', () => {
    const block = textBlock({
      format: 'html',
      body: '<h2 style="text-align: center">Title</h2><h1>Big</h1><p>A <strong>b</strong> <em>i</em> <u>u</u> <a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a></p>'
        + '<ul><li>x</li></ul><ol><li>y</li></ol><blockquote><p>q</p></blockquote><p onclick="x()" style="color:red">p</p><img src=x onerror=alert(1)><script>alert(1)</script><iframe src="//x"></iframe>',
    });
    expect(block.body).toContain('<h2 style="text-align:center">Title</h2>');
    expect(block.body).not.toContain('<h1');
    expect(block.body).toContain('Big');
    expect(block.body).toContain('<strong>b</strong> <em>i</em> <u>u</u>');
    expect(block.body).not.toMatch(/javascript:|onclick|onerror|<img|<script|<iframe|color:red/);
    expect(block.body).toContain('<a>bad</a> <a href="https://ok.example" rel="noopener noreferrer">ok</a>');
    expect(block.body).toContain('<ul><li>x</li></ul><ol><li>y</li></ol><blockquote><p>q</p></blockquote>');
  });

  test('two columns: one text flows over both as before; with a right column each fills its own', () => {
    const flowing = render([home([{ type: 'text', id: 't1', variant: 'columns', body: 'Only one' }])]);
    expect(flowing).toContain('<div class="pp-prose pp-columns"><p>Only one</p></div>');
    const split = render([home([{ type: 'text', id: 't1', variant: 'columns', format: 'html', body: '<p>Left</p>', bodyRight: '<p>Right</p>' }])]);
    expect(split).toContain('<div class="pp-two-cols"><div class="pp-prose"><p>Left</p></div><div class="pp-prose"><p>Right</p></div></div>');
    // The right column exists for the columns layout only.
    expect(textBlock({ variant: 'left', format: 'html', body: '<p>L</p>', bodyRight: '<p>R</p>' }).bodyRight).toBe('');
  });
});

describe('uploaded fonts', () => {
  test('a woff or ttf weight is linked in its own format; woff2 stays as before', () => {
    const { fontFaces } = require('../renderer')._internal;
    const css = fontFaces({
      body: { family: 'Studio Sans', weights: [400, 600], formats: { 400: 'ttf', 600: 'woff' } },
      heading: { family: 'Inter', weights: [600], formats: { 600: 'woff2' } },
    });
    expect(css).toContain('src:url(\'/fonts/Studio-Sans/400.ttf\') format(\'truetype\')');
    expect(css).toContain('src:url(\'/fonts/Studio-Sans/600.woff\') format(\'woff\')');
    expect(css).toContain('src:url(\'/fonts/Inter/600.woff2\') format(\'woff2\')');
    // A family listed before formats were known keeps woff2.
    expect(fontFaces({ body: { family: 'Old', weights: [400] }, heading: null })).toContain('/fonts/Old/400.woff2\') format(\'woff2\')');
  });
});

describe('booking button', () => {
  const booking = (over) => ({ type: 'booking', id: 'b1', heading: 'Book', buttonLabel: 'Book a session', ...over });

  test('opens the booking page, with the chosen service preselected while it can be booked', () => {
    const on = { enabled: true, url: '/book', serviceIds: new Set([7]) };
    expect(render([home([booking({ serviceId: 7 })])], { ctx: { booking: on } })).toContain('href="/book?service=7"');
    // A service that cannot be booked any more: the booking page as such.
    expect(render([home([booking({ serviceId: 9 })])], { ctx: { booking: on } })).toContain('href="/book"');
    expect(normalizeDocument({ pages: [home([booking({ serviceId: 'x' })])] }).document.pages[0].blocks[0].serviceId).toBeNull();
  });

  test('hidden on the website while booking is off; the preview shows it with why', () => {
    expect(render([home([booking({})])], { ctx: { booking: { enabled: false } } })).not.toContain('pp-booking');
    const preview = render([home([booking({})])], { ctx: { booking: { enabled: false }, preview: true } });
    expect(preview).toContain('Book a session');
    expect(preview).toContain('Hidden on the website: client booking is off or nothing can be booked yet.');
  });
});

test('a font file is addressed with its version, so a replaced file gets a new address', () => {
  const { fontFaces } = require('../renderer')._internal;
  const css = fontFaces({ body: { family: 'Studio Sans', weights: [400], formats: { 400: 'ttf' }, versions: { 400: 'k3x9' } }, heading: null });
  expect(css).toContain("src:url('/fonts/Studio-Sans/400.ttf?v=k3x9') format('truetype')");
});
