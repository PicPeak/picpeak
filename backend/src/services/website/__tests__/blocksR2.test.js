/**
 * Website builder (issue 2618): the FAQ, steps, call-to-action, logos and
 * social links blocks. No script on the page; every field validated,
 * escaped and capped like the other blocks.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'renderer-test-secret-0123456789abcdef';

const { renderPage } = require('../renderer');
const { normalizeDocument } = require('../document');

const ASSET = 'a'.repeat(24);

function normalize(blocks, pages = []) {
  return normalizeDocument({ pages: [{ id: 'home', slug: 'home', title: 'Home', isHome: true, blocks }, ...pages] });
}

function render(blocks, { pages = [], ctx = {} } = {}) {
  const { document } = normalize(blocks, pages);
  return renderPage({
    document, page: document.pages[0], preview: false, locale: 'en',
    branding: { companyName: 'Studio', colors: {} },
    theme: { background: '#ffffff', text: '#111111', accent: '#7c3aed', buttonStyle: 'solid', radius: 'md' },
    fonts: { body: null, heading: null }, photos: new Map(),
    assets: new Map([[ASSET, { id: ASSET, kind: 'image', width: 400, height: 200, rendition_keys: JSON.stringify({ 640: 'k640' }) }]]),
    events: new Map(), covers: new Map(), packages: new Map(), booking: { enabled: true, url: '/book', serviceIds: new Set() },
    legalLinks: [], baseUrl: '', robots: '', customCss: '', sanitizeCustomHtml: (h) => h, mediaSigner: undefined,
    ...ctx,
  });
}

const PAYLOAD = '<img src=x onerror=alert(1)><script>alert(2)</script>';

describe('FAQ', () => {
  test('questions open and close without script; answers are rich text kept to the allowlist', () => {
    const html = render([{ type: 'faq', heading: 'Questions', items: [
      { question: 'How long?', answer: '<p>About <strong>two</strong> weeks.</p><script>x()</script>' },
      { question: PAYLOAD, answer: '<p>ok</p>' },
      { question: '', answer: '<p>Unfinished</p>' },
    ] }]);
    expect(html).toContain('<details class="pp-faq__item"><summary>How long?</summary><div class="pp-prose"><p>About <strong>two</strong> weeks.</p></div></details>');
    expect(html).not.toMatch(/<script>|<img src=x/);
    expect(html).not.toContain('Unfinished');
    expect(html).not.toMatch(/<script[\s>]/);
  });

  test('item count and answer length are capped and reported', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ question: `Q${i}`, answer: '<p>a</p>' }));
    const { document, errors } = normalize([{ type: 'faq', items }, { type: 'faq', items: [{ question: 'Q', answer: `<p>${'x'.repeat(6000)}</p>` }] }]);
    expect(document.pages[0].blocks[0].items).toHaveLength(24);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TOO_MANY_ITEMS', field: 'items' }), expect.objectContaining({ code: 'TEXT_TOO_LONG', field: 'answer' })]));
  });
});

describe('steps', () => {
  test('numbered steps in order; at most eight', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `Step ${i + 1}`, text: 'Short **text**' }));
    const { document, errors } = normalize([{ type: 'steps', items }]);
    expect(document.pages[0].blocks[0].items).toHaveLength(8);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TOO_MANY_ITEMS', field: 'items' })]));
    const html = render([{ type: 'steps', items: items.slice(0, 3) }]);
    expect(html).toContain('<ol class="pp-steps" style="--steps:3">');
    expect(html).toMatch(/<li class="pp-step"><span class="pp-step__mark" aria-hidden="true">1<\/span><h3 class="pp-h">Step 1<\/h3><p>Short <strong>text<\/strong><\/p><\/li>/);
  });

  test('the icon style shows a known icon, an unknown icon falls back to the number', () => {
    const html = render([{ type: 'steps', variant: 'icons', items: [{ title: 'Shoot', icon: 'camera' }, { title: 'Pick', icon: 'javascript' }] }]);
    expect(html).toMatch(/<span class="pp-step__mark" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><h3 class="pp-h">Shoot/);
    expect(html).toContain('<span class="pp-step__mark" aria-hidden="true">2</span><h3 class="pp-h">Pick</h3>');
  });
});

describe('call to action', () => {
  const pages = [{ id: 'about', slug: 'about', title: 'About', blocks: [{ id: 'form', type: 'contact' }] }, { id: 'secret', slug: 'secret', title: 'Secret', hidden: true, blocks: [] }];

  test('up to two buttons to a page, a block, the booking page or an external address', () => {
    const html = render([{ type: 'cta', heading: 'Ready?', text: '<p>Let us talk.</p>', buttons: [
      { label: 'Write to us', target: { kind: 'anchor', pageId: 'about', blockId: 'form' } },
      { label: 'Book', target: { kind: 'booking' } },
      { label: 'Third', target: { kind: 'url', url: 'https://example.com' } },
    ] }], { pages });
    expect(html).toContain('href="/about#b-form"');
    expect(html).toContain('href="/book"');
    expect(html).not.toContain('Third');
    expect(html).toContain('<div class="pp-prose"><p>Let us talk.</p></div>');
  });

  test('a target that leads nowhere drops its button', () => {
    const html = render([{ type: 'cta', heading: 'Ready?', buttons: [
      { label: 'Hidden', target: { kind: 'page', pageId: 'secret' } },
      { label: 'Gone', target: { kind: 'anchor', pageId: 'about', blockId: 'nope' } },
      { label: 'Evil', target: { kind: 'url', url: 'javascript:alert(1)' } },
      { label: 'About', target: { kind: 'page', pageId: 'about' } },
    ] }], { pages });
    expect(html).not.toMatch(/Hidden|Gone|Evil|javascript:/);
    // Two buttons at most: the fourth is not kept.
    expect(html).not.toMatch(/pp-btn[^>]*>About</);
    const two = render([{ type: 'cta', buttons: [{ label: 'About', target: { kind: 'page', pageId: 'about' } }] }], { pages });
    expect(two).toContain('href="/about">About</a>');
    // Booking off: no booking button.
    expect(render([{ type: 'cta', buttons: [{ label: 'Book', target: { kind: 'booking' } }] }], { ctx: { booking: { enabled: false } } })).not.toContain('>Book<');
  });
});

describe('logos', () => {
  test('a strip of uploaded logos, each optionally linked, grey until hovered when chosen', () => {
    const html = render([{ type: 'logos', heading: 'Featured in', grayscale: true, items: [
      { image: { source: 'asset', id: ASSET, alt: 'Vogue' }, url: 'https://vogue.example' },
      { image: { source: 'asset', id: ASSET, alt: 'Plain' }, url: 'javascript:alert(1)' },
      { image: null, url: 'https://empty.example' },
    ] }]);
    expect(html).toContain('pp-logos pp-logos--strip pp-logos--gray');
    expect(html).toMatch(/<a class="pp-logo" href="https:\/\/vogue.example" rel="noopener noreferrer"><img[^>]*alt="Vogue"/);
    expect(html).toMatch(/<span class="pp-logo"><img[^>]*alt="Plain"/);
    expect(html).not.toMatch(/javascript:|empty.example/);
  });
});

describe('social links', () => {
  test('one icon per network, http(s) only, an email address as mailto', () => {
    const html = render([{ type: 'social', heading: 'Follow us', links: [
      { network: 'instagram', url: 'https://instagram.com/studio' },
      { network: 'tiktok', url: 'javascript:alert(1)' },
      { network: 'email', url: 'hello@studio.example' },
      { network: 'myspace', url: 'https://myspace.com/x' },
      { network: 'youtube', url: '/relative' },
    ] }]);
    expect(html).toMatch(/<a class="pp-social__link" href="https:\/\/instagram.com\/studio" rel="noopener noreferrer" aria-label="Instagram"><svg/);
    expect(html).toContain('href="mailto:hello@studio.example"');
    expect(html).not.toMatch(/javascript:|myspace|\/relative|aria-label="TikTok"|aria-label="YouTube"/);
  });

  test('the buttons style names each network', () => {
    const html = render([{ type: 'social', variant: 'buttons', links: [{ network: 'linkedin', url: 'https://linkedin.com/in/x' }] }]);
    expect(html).toMatch(/<svg[^>]*><\/?[a-z].*<\/svg><span>LinkedIn<\/span><\/a>/);
  });
});

test('none of the new blocks puts a script or an inline handler on the page', () => {
  const html = render([
    { type: 'faq', items: [{ question: 'Q', answer: '<p onclick="x()">A</p>' }] },
    { type: 'steps', items: [{ title: 'S', text: 'T' }, { title: 'S2', text: 'T2' }] },
    { type: 'cta', heading: 'C', text: '<p onmouseover="x()">t</p>', buttons: [{ label: 'B', target: { kind: 'booking' } }] },
    { type: 'logos', items: [{ image: { source: 'asset', id: ASSET, alt: 'L' }, url: '' }] },
    { type: 'social', links: [{ network: 'facebook', url: 'https://facebook.com/x' }] },
  ]);
  expect(html).not.toMatch(/<script|\son[a-z]+=/i);
});

test('logo images count as the page\'s images (loaded, picked, published like any other)', () => {
  const { collectReferences } = require('../document');
  const { document } = normalize([{ type: 'logos', items: [{ image: { source: 'asset', id: ASSET } }, { image: { source: 'photo', id: 5 } }] }]);
  expect(collectReferences(document)).toMatchObject({ assetIds: [ASSET], photoIds: [5] });
});
