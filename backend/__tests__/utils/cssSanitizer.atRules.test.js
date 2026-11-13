/**
 * cssSanitizer — at-rules are compared by their decoded name.
 *
 * `@\import` and `@\69mport` are `@import` to a browser. A literal pattern on
 * the raw text does not see them, so every at-keyword is decoded and checked
 * against an allow-list; @import, @charset and @namespace are removed in any
 * spelling.
 */

const { sanitizeCSS, sanitizeCss, stripDisallowedAtRules } = require('../../src/utils/cssSanitizer');

/** What a CSS parser sees: comments are discarded before parsing. */
const asParsed = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const ESCAPED_IMPORTS = [
  ['identity escape', '@\\import "https://remote.example/x.css";'],
  ['hex escape', '@\\69mport "https://remote.example/x.css";'],
  ['hex escape + space', '@\\69 mport "https://remote.example/x.css";'],
  ['uppercase hex escape', '@\\49MPORT "https://remote.example/x.css";'],
  ['escape mid-name', '@imp\\6f rt url(https://remote.example/x.css);'],
];

describe('sanitizeCSS — at-rules', () => {
  it.each(ESCAPED_IMPORTS)('removes an @import spelled with %s', (_label, rule) => {
    const { sanitized, warnings } = sanitizeCSS(`${rule}\n.a{color:red}`);
    expect(asParsed(sanitized)).not.toContain('remote.example');
    expect(asParsed(sanitized)).not.toMatch(/@/);
    expect(sanitized).toContain('.a{color:red}');
    expect(warnings.join(' ')).toMatch(/at-rule/);
  });

  it.each([
    ['@\\63harset "utf-8";'],
    ['@\\6e amespace svg url(http://www.w3.org/2000/svg);'],
    ['@\\charset "utf-8";'],
  ])('removes escaped %s', (rule) => {
    const { sanitized } = sanitizeCSS(`${rule}.a{color:red}`);
    expect(asParsed(sanitized)).not.toMatch(/@/);
    expect(sanitized).toContain('.a{color:red}');
  });

  it('removes an at-rule that is not on the allow-list, block and all', () => {
    const { sanitized } = sanitizeCSS('@unknown foo { .x{color:red} } .a{color:blue}');
    expect(asParsed(sanitized).trim()).toBe('.a{color:blue}');
  });

  it('removes an escaped @import nested inside a style rule', () => {
    const { sanitized } = sanitizeCSS('.a{@\\69mport "https://remote.example/x.css";color:red}');
    expect(asParsed(sanitized)).toBe('.a{color:red}');
  });

  it('keeps the allowed at-rules byte-identical', () => {
    const css = [
      '@media (max-width: 600px){.a{color:red}}',
      '@supports (display:grid){.b{display:grid}}',
      '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '@-webkit-keyframes spin{from{opacity:0}to{opacity:1}}',
      '@font-face{font-family:"X";src:local("X")}',
      '@layer base{.c{margin:0}}',
      '@container (min-width: 400px){.d{padding:0}}',
      '@page{margin:1cm}',
    ].join('');
    const { sanitized, warnings } = sanitizeCSS(css);
    expect(sanitized).toBe(css);
    expect(warnings).toEqual([]);
  });

  it('leaves an @ inside a string or after an escaped backslash alone', () => {
    const css = '.a::after{content:"mail@example.com"}.b\\@x{color:red}';
    const { sanitized, warnings } = sanitizeCSS(css);
    expect(sanitized).toBe(css);
    expect(warnings).toEqual([]);
  });

  it('is idempotent', () => {
    const once = sanitizeCSS('@\\69mport "https://remote.example/x.css";.a{color:red}').sanitized;
    const twice = sanitizeCSS(once);
    expect(twice.sanitized).toBe(once);
    expect(twice.warnings).toEqual([]);
  });
});

describe('stripDisallowedAtRules', () => {
  it('decodes six-digit escapes', () => {
    const { sanitized, blocked } = stripDisallowedAtRules('@\\000069mport "https://remote.example/x.css";.a{color:red}');
    expect(blocked).toBe(1);
    expect(asParsed(sanitized)).toBe('.a{color:red}');
  });

  it('counts every removed rule', () => {
    const { blocked } = stripDisallowedAtRules('@\\import "a";@\\69mport "b";@media print{.a{color:red}}');
    expect(blocked).toBe(2);
  });

  it('does not let an unterminated quote hide a later at-rule', () => {
    const { sanitized } = stripDisallowedAtRules('p{font-family:\'don\'t}@\\import "https://remote.example/x.css";');
    expect(asParsed(sanitized)).not.toContain('remote.example');
  });
});

describe('sanitizeCss (public-site) — at-rules', () => {
  it.each(ESCAPED_IMPORTS)('removes an @import spelled with %s', (_label, rule) => {
    const out = sanitizeCss(`${rule}\n.a{color:red}`);
    expect(asParsed(out)).not.toContain('remote.example');
    expect(out).toContain('.a{color:red}');
  });

  it('keeps @media and @font-face', () => {
    const css = '@media print{.a{color:red}}@font-face{font-family:"X";src:url(https://cdn.example/x.woff2)}';
    expect(sanitizeCss(css)).toBe(css);
  });
});
