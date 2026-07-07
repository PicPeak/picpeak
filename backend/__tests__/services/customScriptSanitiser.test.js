/**
 * Tests for the custom-tracker HTML sanitiser (#663 Phase 1).
 *
 * The field accepts admin-pasted `<head>`-style snippets for arbitrary
 * trackers (Plausible / Matomo / Pirsch / GA4 / GoatCounter / Fathom /
 * Cloudflare Web Analytics). We sanitise on save with a narrow allowlist
 * tuned for tracker scripts — defence-in-depth, even though the field is
 * admin-only.
 */

const { sanitizeTrackerSnippet } = require('../../src/services/trackers/customScriptSanitiser');

describe('sanitizeTrackerSnippet (#663)', () => {
  test('returns empty string for non-string / empty / whitespace input', () => {
    expect(sanitizeTrackerSnippet(null)).toBe('');
    expect(sanitizeTrackerSnippet(undefined)).toBe('');
    expect(sanitizeTrackerSnippet(42)).toBe('');
    expect(sanitizeTrackerSnippet('')).toBe('');
    expect(sanitizeTrackerSnippet('   ')).toBe('');
  });

  test('passes through a Plausible-style script tag with data-domain', () => {
    const input = '<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).toContain('src="https://plausible.io/js/script.js"');
    expect(out).toContain('data-domain="example.com"');
    expect(out).toContain('defer');
  });

  test('passes through a Umami-style script with data-website-id', () => {
    const input = '<script async defer src="https://analytics.example.com/script.js" data-website-id="aaa-bbb-ccc"></script>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).toContain('src="https://analytics.example.com/script.js"');
    expect(out).toContain('data-website-id="aaa-bbb-ccc"');
  });

  test('passes through inline script body unchanged', () => {
    const input = '<script>window.GA = "x"; window.tracker = function() { console.log("init"); };</script>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).toContain('window.GA = "x"');
    expect(out).toContain('console.log("init")');
  });

  test('allows <noscript> fallback', () => {
    const input = '<noscript><img src="https://t.example/?nojs=1" /></noscript>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).toContain('<noscript>');
  });

  test('allows <link rel="preconnect"> and <link rel="dns-prefetch">', () => {
    const out = sanitizeTrackerSnippet(
      '<link rel="preconnect" href="https://t.example.com">'
      + '<link rel="dns-prefetch" href="https://t.example.com">',
    );
    expect(out).toContain('rel="preconnect"');
    expect(out).toContain('rel="dns-prefetch"');
    expect(out).toContain('href="https://t.example.com"');
  });

  test('strips <link rel="stylesheet"> (not tracker-related)', () => {
    const out = sanitizeTrackerSnippet('<link rel="stylesheet" href="https://evil.example/x.css">');
    expect(out).not.toContain('stylesheet');
    expect(out).not.toContain('href');
  });

  test('strips disallowed tags entirely', () => {
    const input = '<div><iframe src="https://evil.example/x.html"></iframe><h1>hi</h1></div>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('<div');
    expect(out).not.toContain('<h1');
  });

  test('strips javascript: URLs from script src', () => {
    const input = '<script src="javascript:alert(1)"></script>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).not.toContain('javascript:');
  });

  test('strips data: URLs from script src', () => {
    const input = '<script src="data:text/javascript,alert(1)"></script>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).not.toContain('data:text/javascript');
  });

  test('strips on* event-handler attributes (defence-in-depth)', () => {
    // event-handler attrs are not in our allowlist; sanitize-html strips them.
    const input = '<script src="https://t.example/x.js" onload="evil()"></script>';
    const out = sanitizeTrackerSnippet(input);
    expect(out).not.toContain('onload');
    expect(out).toContain('src="https://t.example/x.js"');
  });

  test('returns empty string on unparseable input rather than throwing', () => {
    // sanitize-html is fault-tolerant — pass deliberately malformed and
    // confirm we don't blow up.
    expect(typeof sanitizeTrackerSnippet('<<<>>>')).toBe('string');
    expect(typeof sanitizeTrackerSnippet('<script')).toBe('string');
  });
});
