/**
 * cssSanitizer — remote url() removal.
 *
 * Regression: `sanitizeCSS` used to "block" a remote url() by prefixing it
 * with a `/* BLOCKED URL *\/` COMMENT and leaving the URL in place. CSS
 * comments are discarded during tokenization, so the declaration a browser
 * actually parsed still carried the live URL — while the returned warning
 * told the caller it had been blocked.
 *
 * The load-bearing assertion in most of these is therefore not "the marker is
 * gone" but "the HOST is gone", checked against the comment-stripped text the
 * way a parser would see it.
 */

const { sanitizeCSS, sanitizeCss, stripDisallowedUrls } = require('../../src/utils/cssSanitizer');

/** What a CSS parser sees: comments are discarded before parsing. */
const asParsed = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('stripDisallowedUrls', () => {
  it('removes a remote url() rather than commenting near it', () => {
    const { sanitized, blocked } = stripDisallowedUrls('.a{background:url(https://evil.example/p.gif)}');

    expect(blocked).toBe(1);
    expect(sanitized).not.toContain('evil.example');
    expect(asParsed(sanitized)).not.toContain('evil.example');
  });

  it.each([
    ['unquoted', '.a{background:url(https://evil.example/p.gif)}'],
    ['single-quoted', '.a{background:url(\'https://evil.example/p.gif\')}'],
    ['double-quoted', '.a{background:url("https://evil.example/p.gif")}'],
    ['spaced', '.a{background:url(  https://evil.example/p.gif  )}'],
    ['uppercase URL(', '.a{background:URL(https://evil.example/p.gif)}'],
    ['protocol-relative', '.a{background:url(//evil.example/p.gif)}'],
    ['scheme-less host', '.a{background:url(evil.example/p.gif)}'],
    ['http', '.a{background:url(http://evil.example/p.gif)}'],
  ])('removes a %s remote url()', (_label, css) => {
    expect(asParsed(stripDisallowedUrls(css).sanitized)).not.toContain('evil.example');
  });

  it('keeps an inline data: image', () => {
    const css = '.a{background:url(data:image/png;base64,iVBORw0KGgo=)}';
    const { sanitized, blocked } = stripDisallowedUrls(css);

    expect(blocked).toBe(0);
    expect(sanitized).toBe(css);
  });

  it.each(['jpeg', 'jpg', 'png', 'gif', 'webp'])('keeps a data:image/%s URI', (type) => {
    const css = `.a{background:url(data:image/${type};base64,AAAA)}`;
    expect(stripDisallowedUrls(css).sanitized).toBe(css);
  });

  it('removes a data: URI that is not a raster image', () => {
    // data:image/svg+xml is a script-execution vector in some contexts.
    const out = stripDisallowedUrls('.a{background:url(data:image/svg+xml;base64,AAAA)}').sanitized;
    expect(out).not.toContain('svg+xml');
  });

  it('leaves the rest of a shorthand declaration intact', () => {
    const out = stripDisallowedUrls('.a{background:#fff url(https://x/p.gif) no-repeat center}').sanitized;

    expect(out).toContain('#fff');
    expect(out).toContain('no-repeat center');
    expect(out).toContain('none');
    expect(out).not.toContain('https://x');
  });

  it('counts and removes every offender in one stylesheet', () => {
    const { sanitized, blocked } = stripDisallowedUrls(
      '.a{background:url(https://a.example/1.gif)}'
      + '.b{background:url(https://b.example/2.gif)}'
      + '.c{background:url(data:image/png;base64,AAAA)}'
    );

    expect(blocked).toBe(2);
    expect(sanitized).not.toContain('a.example');
    expect(sanitized).not.toContain('b.example');
    expect(sanitized).toContain('data:image/png');
  });

  it('is idempotent', () => {
    const once = stripDisallowedUrls('.a{background:url(https://x/p.gif)}').sanitized;
    expect(stripDisallowedUrls(once).sanitized).toBe(once);
  });

  it('handles empty and nullish input', () => {
    expect(stripDisallowedUrls('').sanitized).toBe('');
    expect(stripDisallowedUrls(null).sanitized).toBe('');
    expect(stripDisallowedUrls(undefined).sanitized).toBe('');
  });
});

describe('sanitizeCSS', () => {
  it('no longer emits an inert BLOCKED URL marker', () => {
    const { sanitized } = sanitizeCSS('.a{background:url(https://evil.example/p.gif)}');

    expect(sanitized).not.toContain('BLOCKED URL');
    expect(asParsed(sanitized)).not.toContain('evil.example');
  });

  it('warns with the number it actually removed', () => {
    const { warnings } = sanitizeCSS(
      '.a{background:url(https://a.example/1.gif)}.b{background:url(https://b.example/2.gif)}'
    );
    expect(warnings.some((w) => /Blocked 2 external URL references/.test(w))).toBe(true);
  });

  it('does not warn about URLs when there are none', () => {
    const { warnings } = sanitizeCSS('.a{color:red}');
    expect(warnings.filter((w) => /external URL/.test(w))).toHaveLength(0);
  });

  it('still blocks the other forbidden patterns', () => {
    const { sanitized } = sanitizeCSS(
      '@import url("https://x/e.css"); .a{width:expression(alert(1));behavior:url(e.htc)}'
    );
    expect(sanitized).not.toContain('@import');
    expect(sanitized).not.toContain('expression(');
    expect(asParsed(sanitized)).not.toContain('https://x/e.css');
  });

  it('neutralises a javascript: url()', () => {
    const { sanitized } = sanitizeCSS('.a{background:url(javascript:alert(1))}');
    expect(asParsed(sanitized)).not.toContain('javascript:');
  });

  it('leaves ordinary declarations untouched', () => {
    const css = '.btn { color: #fff; padding: 12px 24px; border-radius: 6px; }';
    expect(sanitizeCSS(css).sanitized).toBe(css);
  });
});

describe('sanitizeCss (lowercase) — public-site path, deliberately unchanged', () => {
  it('still permits a remote url()', () => {
    // This function never blocked remote URLs and never claimed to. The
    // public-site CSS surface may legitimately reference a remote font or
    // background; changing that is a product decision, not this bug fix.
    const out = sanitizeCss('.a{background:url(https://cdn.example/x.png)}');
    expect(out).toContain('https://cdn.example/x.png');
  });

  it('still strips @import and javascript: urls', () => {
    expect(sanitizeCss('@import url("https://x/e.css"); .a{color:red}')).not.toContain('@import');
    expect(sanitizeCss('.a{background:url(\'javascript:alert(1)\')}')).not.toContain('javascript:');
  });
});
