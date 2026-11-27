/**
 * Website builder (issue 2618): the menu (header) and the footer have their
 * own settings. A document saved before them renders exactly as it did:
 * the menu comes from the page order and "show in the menu", the footer
 * from the branding, the pages and the legal links.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'renderer-test-secret-0123456789abcdef';

const { renderPage } = require('../renderer');
const { normalizeDocument } = require('../document');

// Rendered by the renderer before the menu and footer settings existed.
const BEFORE = {
  'header': '<header class="pp-header"><div class="pp-wrap pp-header__in"><a class="pp-brand" href="/"><img src="/uploads/logo.png" alt="" height="40"><span>Studio</span></a><nav class="pp-nav" aria-label="Main"><ul><li><a href="/">Home</a></li><li><a href="/about" aria-current="page">About us</a></li></ul></nav><details class="pp-menu"><summary>Menu</summary><nav aria-label="Main"><ul><li><a href="/">Home</a></li><li><a href="/about" aria-current="page">About us</a></li></ul></nav></details></div></header>',
  'footer': '<footer class="pp-footer"><div class="pp-wrap pp-footer__in"><div><strong>Studio</strong><p>Weddings</p><p>Zurich</p></div><nav aria-label="Pages"><ul><li><a href="/">Home</a></li><li><a href="/about">About us</a></li><li><a href="/faq">FAQ</a></li></ul></nav><ul><li><a href="/impressum">Impressum</a></li><li><a href="mailto:hi@studio.example">Contact</a></li></ul><p class="pp-copy">© 2026 Studio</p></div></footer>'
};

const LEGACY_PAGES = [
  { id: 'home', slug: 'home', title: 'Home', isHome: true, blocks: [] },
  { id: 'about', slug: 'about', title: 'About', navLabel: 'About us', blocks: [{ id: 'form', type: 'contact' }] },
  { id: 'secret', slug: 'secret', title: 'Secret', hidden: true, blocks: [] },
  { id: 'faq', slug: 'faq', title: 'FAQ', inNav: false, blocks: [] },
];

function render(raw, { pageId = 'about', ctx = {} } = {}) {
  const { document, errors } = normalizeDocument(raw);
  const html = renderPage({
    document, page: document.pages.find((p) => p.id === pageId), preview: false, locale: 'en',
    branding: { companyName: 'Studio', companyTagline: 'Weddings', supportEmail: 'hi@studio.example', logoUrl: '/uploads/logo.png', footerText: 'Zurich', colors: {} },
    theme: { background: '#ffffff', text: '#111111', accent: '#7c3aed', buttonStyle: 'solid', radius: 'md' }, fonts: { body: null, heading: null },
    photos: new Map(), assets: new Map(), events: new Map(), covers: new Map(), packages: new Map(), booking: { enabled: false },
    legalLinks: [{ href: '/impressum', label: 'Impressum' }], baseUrl: '', robots: '', customCss: '', sanitizeCustomHtml: (h) => h,
    now: new Date('2026-06-01T00:00:00Z'), ...ctx,
  });
  const body = html.slice(html.indexOf('<body'));
  return { html, errors, document, header: body.match(/<header[\s\S]*<\/header>/)[0], footer: body.match(/<footer[\s\S]*<\/footer>/)[0] };
}

describe('the menu', () => {
  test('a document from before the menu settings renders its header exactly as before', () => {
    const { header, document } = render({ pages: LEGACY_PAGES });
    expect(header).toBe(BEFORE.header);
    expect(document.menu.items).toEqual([
      { id: 'home', label: '', hidden: false, target: { kind: 'page', pageId: 'home' } },
      { id: 'about', label: '', hidden: false, target: { kind: 'page', pageId: 'about' } },
      { id: 'secret', label: '', hidden: false, target: { kind: 'page', pageId: 'secret' } },
    ]);
    expect(document.pages[0].inNav).toBeUndefined();
    // Once saved, the menu is what it says, whatever the pages say.
    expect(render(document).header).toBe(BEFORE.header);
  });

  test('its own order, labels, hidden items, and items that are not pages', () => {
    const { header } = render({ pages: LEGACY_PAGES, menu: { items: [
      { id: 'm1', label: 'Contact', target: { kind: 'anchor', pageId: 'about', blockId: 'form' } },
      { id: 'm2', label: '', target: { kind: 'page', pageId: 'faq' } },
      { id: 'm3', label: 'Home', hidden: true, target: { kind: 'page', pageId: 'home' } },
      { id: 'm4', label: 'Shop', target: { kind: 'url', url: 'https://shop.example' } },
      { id: 'm5', label: 'Book', target: { kind: 'booking' } },
      { id: 'm6', label: 'Privacy', target: { kind: 'legal', slug: 'datenschutz' } },
      { id: 'm7', label: 'Bad', target: { kind: 'url', url: 'javascript:alert(1)' } },
      { id: 'm8', label: '', target: { kind: 'url', url: 'https://nolabel.example' } },
    ] } });
    const nav = header.match(/<nav class="pp-nav[^"]*" aria-label="Main"><ul>([\s\S]*?)<\/ul>/)[1];
    expect(nav).toBe('<li><a href="#b-form">Contact</a></li><li><a href="/faq">FAQ</a></li><li><a href="https://shop.example" rel="noopener noreferrer">Shop</a></li><li><a href="/datenschutz">Privacy</a></li>');
  });

  test('design: layout, style, sticky, colours and the phone menu', () => {
    const { header } = render({ pages: LEGACY_PAGES, menu: {
      layout: 'center', style: 'pill', sticky: false, mobile: 'panel', background: '#102030', text: '#FFFFFF', items: [{ id: 'm', target: { kind: 'page', pageId: 'home' } }],
    } });
    expect(header).toMatch(/^<header class="pp-header pp-header--center pp-header--static pp-nav--pill" style="--bg:#102030;--text:#ffffff">/);
    expect(header).toContain('<details class="pp-menu pp-menu--panel">');
    const bad = render({ pages: LEGACY_PAGES, menu: { layout: 'diagonal', style: 'x', background: 'red;}body{x:y', items: [] } });
    expect(bad.document.menu).toMatchObject({ layout: 'left', style: 'plain', sticky: true, transparent: false, mobile: 'dropdown', background: null, text: null });
  });

  test('transparent over a full-picture hero only on a page that starts with one', () => {
    const pages = [
      { id: 'home', slug: 'home', title: 'Home', isHome: true, blocks: [{ id: 'h', type: 'hero', variant: 'overlay', heading: 'Hi' }] },
      { id: 'about', slug: 'about', title: 'About', blocks: [{ type: 'text', body: 'x' }] },
    ];
    expect(render({ pages, menu: { transparent: true, items: [] } }, { pageId: 'home' }).header).toMatch(/^<header class="pp-header pp-header--over">/);
    expect(render({ pages, menu: { transparent: true, items: [] } }, { pageId: 'about' }).header).toMatch(/^<header class="pp-header">/);
  });

  test('at most twelve items, labels capped', () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, label: 'x'.repeat(80), target: { kind: 'page', pageId: 'home' } }));
    const { document, errors } = normalizeDocument({ pages: LEGACY_PAGES, menu: { items } });
    expect(document.menu.items).toHaveLength(12);
    expect(document.menu.items[0].label).toHaveLength(60);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TOO_MANY_ITEMS', field: 'menu' }), expect.objectContaining({ code: 'TEXT_TOO_LONG', field: 'menuLabel' })]));
  });
});

describe('the footer', () => {
  test('a document from before the footer settings renders its footer exactly as before', () => {
    const { footer, document } = render({ pages: LEGACY_PAGES });
    expect(footer).toBe(BEFORE.footer);
    expect(document.footer).toMatchObject({ legal: 'column', copyright: '', background: 'default' });
    expect(document.footer.columns.map((c) => c.kind)).toEqual(['brand', 'pages']);
    expect(render(document).footer).toBe(BEFORE.footer);
  });

  test('columns of text, links, contact details and social icons', () => {
    const { footer } = render({ pages: LEGACY_PAGES, footer: { legal: 'off', columns: [
      { id: 'c1', kind: 'text', heading: 'Studio', text: '<p>Since <strong>2010</strong></p><script>x()</script>' },
      { id: 'c2', kind: 'links', heading: 'More', links: [
        { label: 'Contact', target: { kind: 'anchor', pageId: 'about', blockId: 'form' } },
        { label: 'Evil', target: { kind: 'url', url: 'javascript:alert(1)' } },
      ] },
      { id: 'c3', kind: 'contact', heading: 'Visit', email: 'hi@studio.example', phone: '+41 44 123 45 67', address: 'Seestrasse 1\n8000 Zürich' },
      { id: 'c4', kind: 'social', social: [{ network: 'instagram', url: 'https://instagram.com/studio' }] },
    ] } });
    expect(footer).toContain('<div><h2 class="pp-footer__h">Studio</h2><div class="pp-prose"><p>Since <strong>2010</strong></p></div></div>');
    expect(footer).toContain('<nav aria-label="More"><h2 class="pp-footer__h">More</h2><ul><li><a href="#b-form">Contact</a></li></ul></nav>');
    expect(footer).toContain('<a href="mailto:hi@studio.example">hi@studio.example</a>');
    expect(footer).toContain('<a href="tel:+41441234567">+41 44 123 45 67</a>');
    expect(footer).toContain('Seestrasse 1<br>8000 Zürich');
    expect(footer).toMatch(/<a class="pp-social__link" href="https:\/\/instagram.com\/studio" rel="noopener noreferrer" aria-label="Instagram"><svg/);
    expect(footer).not.toMatch(/<script|javascript:|Evil|\/impressum/);
    expect(footer).toContain('pp-footer__in pp-footer__in--n4');
  });

  test('legal links at the bottom, a copyright line of its own, a dark background', () => {
    const { footer } = render({ pages: LEGACY_PAGES, footer: { legal: 'bottom', copyright: '© {year} Studio <AG>, all rights reserved', background: 'dark', columns: [{ id: 'b', kind: 'brand' }] } });
    expect(footer).toMatch(/^<footer class="pp-footer pp-dark">/);
    expect(footer).toContain('<div class="pp-copy pp-copy--legal"><span>© 2026 Studio &lt;AG&gt;, all rights reserved</span><ul><li><a href="/impressum">Impressum</a></li><li><a href="mailto:hi@studio.example">Contact</a></li></ul></div>');
  });

  test('validated and capped like the blocks', () => {
    const { document, errors } = normalizeDocument({ pages: LEGACY_PAGES, footer: {
      legal: 'sideways', background: 'custom', backgroundColor: 'url(x)',
      columns: [...Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, kind: 'brand' })), { kind: 'iframe' }],
    } });
    expect(document.footer.columns).toHaveLength(4);
    expect(document.footer).toMatchObject({ legal: 'column', background: 'default' });
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TOO_MANY_ITEMS', field: 'footer' })]));
    const contact = normalizeDocument({ pages: LEGACY_PAGES, footer: { columns: [{ kind: 'contact', email: 'not an address', phone: 'javascript:1' }] } }).document.footer.columns[0];
    expect(contact).toMatchObject({ email: '', phone: '' });
  });
});
