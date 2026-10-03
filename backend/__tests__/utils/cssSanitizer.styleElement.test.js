/**
 * Helpers that keep settings-sourced CSS and colours inside the HTML context
 * they are interpolated into (scanner findings fb8142a9, 75f270b2, 31a5714a).
 *
 *   escapeCssForStyleElement — a raw-text <style> element ends at the first
 *     `</style`, so no `<` may survive into one.
 *   sanitizeCssColor — palette values land in <style>, style="" and
 *     bgcolor="" positions; only a real colour may.
 *   sanitizeCss — the public-site custom-CSS path; it now escapes `<` too, so
 *     the stored value is already inert.
 */
const {
  sanitizeCss, sanitizeCssColor, escapeCssForStyleElement,
} = require('../../src/utils/cssSanitizer');

describe('escapeCssForStyleElement', () => {
  it('rewrites every < as the CSS escape \\3c ', () => {
    expect(escapeCssForStyleElement('a{}</style><b>')).toBe('a{}\\3c /style>\\3c b>');
  });

  it('is idempotent', () => {
    const once = escapeCssForStyleElement('</style>');
    expect(escapeCssForStyleElement(once)).toBe(once);
  });

  it('keeps a following space intact (the escape consumes exactly the one it adds)', () => {
    // `\3c ` + original space: a CSS parser reads `<` then one space.
    expect(escapeCssForStyleElement('a < b')).toBe('a \\3c  b');
  });

  it('leaves > and ordinary CSS alone', () => {
    const css = '.nav > a::after { content: ">"; color: #fff; }';
    expect(escapeCssForStyleElement(css)).toBe(css);
  });

  it('returns an empty string for nullish input', () => {
    expect(escapeCssForStyleElement(null)).toBe('');
    expect(escapeCssForStyleElement(undefined)).toBe('');
  });
});

describe('sanitizeCssColor', () => {
  it.each([
    '#fff', '#FFF', '#ffff', '#16a34a', '#16A34A', '#16a34a80',
    'rgb(22, 163, 74)', 'rgba(22,163,74,0.5)', 'rgb(22 163 74 / 50%)',
    'hsl(142, 76%, 36%)', 'hsla(142 76% 36% / .5)',
    'transparent', 'currentColor', 'white', 'Black',
  ])('accepts %s', (value) => {
    expect(sanitizeCssColor(value)).toBe(value);
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeCssColor('  #fff  ')).toBe('#fff');
  });

  it.each([
    ['closing style tag', 'red;}</style><meta http-equiv="refresh" content="0">'],
    ['statement injection', '#fff; background: url(https://evil.example/x)'],
    ['brace', '#fff}'],
    ['double quote', '#fff" onload="alert(1)'],
    ['single quote', '#fff\' onload=\'alert(1)'],
    ['control character', '#ff\u0000f'],
    ['bare word that is not a colour', 'url(x)'],
    ['css variable', 'var(--x)'],
    ['five hex digits', '#fffff'],
    ['hex with trailing text', '#fff foo'],
    ['functional with letters inside', 'rgb(1,2,3)</style>'],
    ['unknown keyword', 'evil'],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeCssColor(value)).toBeNull();
  });

  it.each([
    ['array', ['#fff']],
    ['object', { toString: () => '#fff' }],
    ['number', 0xffffff],
    ['null', null],
    ['undefined', undefined],
  ])('rejects a non-string (%s)', (_label, value) => {
    expect(sanitizeCssColor(value)).toBeNull();
  });

  it('rejects an over-long functional value', () => {
    expect(sanitizeCssColor(`rgb(${'1,'.repeat(60)}1)`)).toBeNull();
  });
});

describe('sanitizeCss — public-site custom CSS can no longer close the <style> element', () => {
  it.each([
    ['literal', '</style>'],
    ['upper case', '</STYLE>'],
    ['mixed case', '</StYlE>'],
    ['whitespace before the bracket', '</style   >'],
    ['NUL-split (control strip must run first)', '<\u0000/style>'],
    ['newline-split', '<\n/style>'],
  ])('neutralises a %s terminator', (_label, terminator) => {
    const out = sanitizeCss(`a{color:red}${terminator}<meta http-equiv="refresh" content="0">`);
    expect(out).not.toMatch(/<\/style/i);
    expect(out).not.toContain('<');
    expect(out).toMatch(/\\3c \/style/i);
  });

  it('is stable across the write-time and read-time passes', () => {
    const stored = sanitizeCss('a{}</style>');
    expect(sanitizeCss(stored)).toBe(stored);
  });

  it('keeps ordinary CSS byte-identical', () => {
    const css = '.nav > a { color: #fff; background: url(https://cdn.example/x.png); }';
    expect(sanitizeCss(css)).toBe(css);
  });
});
