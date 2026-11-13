/**
 * cssSanitizer — string URLs inside image-set().
 *
 * image-set() and -webkit-image-set() accept a bare string as an image URL,
 * so `image-set("https://x/p.gif" 1x)` is a request just like
 * `url(https://x/p.gif)`. Those strings are held to the same rule as url():
 * only an inline data: raster image may stay.
 */

const { sanitizeCSS, stripDisallowedUrls } = require('../../src/utils/cssSanitizer');

/** What a CSS parser sees: comments are discarded before parsing. */
const asParsed = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('stripDisallowedUrls — image-set()', () => {
  it.each([
    ['double-quoted', '.a{background-image:image-set("https://remote.example/p.gif" 1x)}'],
    ['single-quoted -webkit-', '.a{background-image:-webkit-image-set(\'https://remote.example/p.gif\' 1x)}'],
    ['protocol-relative', '.a{background-image:image-set("//remote.example/p.gif" 1x)}'],
    ['escaped scheme', '.a{background-image:image-set("\\68ttps://remote.example/p.gif" 1x)}'],
    ['type()-qualified', '.a{background-image:image-set("https://remote.example/p.gif" type("image/gif"))}'],
    ['second candidate', `.a{background-image:image-set("${PNG}" 1x, "https://remote.example/p.gif" 2x)}`],
    ['uppercase, spaced', '.a{background-image:IMAGE-SET( "https://remote.example/p.gif" 1x )}'],
    ['escaped function name', '.a{background-image:\\69mage-set("https://remote.example/p.gif" 1x)}'],
  ])('removes a %s string URL', (_label, css) => {
    const { sanitized, blocked } = stripDisallowedUrls(css);
    expect(blocked).toBeGreaterThanOrEqual(1);
    expect(asParsed(sanitized)).not.toContain('remote.example');
  });

  it.each([
    ['var()', '.a{--u:"https://remote.example/p.gif";background-image:image-set(var(--u) 1x)}'],
    ['var() with fallback', '.a{background-image:image-set(var(--u, "https://remote.example/p.gif") 1x)}'],
    ['env()', '.a{background-image:-webkit-image-set(env(x) 1x)}'],
    ['attr()', '.a{background-image:image-set(attr(data-src type(<string>)) 1x)}'],
  ])('removes a %s substitution inside image-set', (_label, css) => {
    const { sanitized, blocked } = stripDisallowedUrls(css);
    expect(blocked).toBe(1);
    expect(sanitized).not.toMatch(/image-set\([^)]*(?:var|env|attr)\(/);
    expect(sanitized).toContain('image-set(none 1x)');
  });

  it('leaves var() outside image-set alone', () => {
    const css = '.a{color:var(--brand, #fff);margin:var(--gap)}';
    expect(stripDisallowedUrls(css)).toEqual({ sanitized: css, blocked: 0 });
  });

  it('keeps a data: image string and its type() hint', () => {
    const css = `.a{background-image:image-set("${PNG}" type("image/png") 1x)}`;
    const { sanitized, blocked } = stripDisallowedUrls(css);
    expect(blocked).toBe(0);
    expect(sanitized).toBe(css);
  });

  it('keeps a url() data: image inside image-set', () => {
    const css = `.a{background-image:image-set(url(${PNG}) 1x)}`;
    expect(stripDisallowedUrls(css)).toEqual({ sanitized: css, blocked: 0 });
  });

  it('leaves strings outside image-set alone', () => {
    const css = '.a{font-family:"https://not-a-url.example"}.b::after{content:"https://x.example"}';
    expect(stripDisallowedUrls(css)).toEqual({ sanitized: css, blocked: 0 });
  });

  it('stops checking strings once image-set() closes', () => {
    const css = `.a{background-image:image-set("${PNG}" 1x);font-family:"Helvetica Neue"}`;
    expect(stripDisallowedUrls(css)).toEqual({ sanitized: css, blocked: 0 });
  });
});

describe('sanitizeCSS — image-set()', () => {
  it('removes the remote string and warns', () => {
    const { sanitized, warnings } = sanitizeCSS(
      '.gallery-page{background-image:image-set("https://remote.example/p.gif" 1x)}'
    );
    expect(asParsed(sanitized)).not.toContain('remote.example');
    expect(warnings.join(' ')).toMatch(/Blocked 1 external URL reference/);
  });

  it('is idempotent', () => {
    const once = sanitizeCSS('.a{background-image:-webkit-image-set("https://remote.example/p.gif" 1x)}').sanitized;
    expect(sanitizeCSS(once)).toEqual({ sanitized: once, warnings: [] });
  });
});
