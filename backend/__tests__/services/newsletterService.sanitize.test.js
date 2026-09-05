/**
 * newsletterService sanitizers (#1264).
 *
 * The composer is the one place in the app where an admin types HTML that is
 * then mailed to every customer. Stored XSS here is the highest-severity bug
 * this feature can have, so these cases are the contract: what gets stripped,
 * what survives, and that running the sanitizer twice changes nothing (which
 * is what lets the render path re-sanitize as a second line of defence).
 */

jest.mock('../../src/database/db', () => ({ db: jest.fn(), logActivity: jest.fn() }));

const {
  sanitizeCampaignBody, sanitizeCampaignCss, MAX_BODY_BYTES,
} = require('../../src/services/newsletterService');

describe('sanitizeCampaignBody', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeCampaignBody('')).toBe('');
    expect(sanitizeCampaignBody(null)).toBe('');
    expect(sanitizeCampaignBody(undefined)).toBe('');
  });

  it.each([
    ['<script>', '<p>hi</p><script>alert(1)</script>', 'alert(1)'],
    ['<iframe>', '<p>hi</p><iframe src="https://evil.example"></iframe>', 'iframe'],
    ['<object>', '<p>hi</p><object data="x.swf"></object>', 'object'],
    ['<form>', '<form action="https://evil.example"><input name="p"></form>', 'form'],
    ['<style> tag', '<style>body{x:1}</style><p>hi</p>', 'body{x:1}'],
  ])('strips %s', (_label, input, forbidden) => {
    expect(sanitizeCampaignBody(input)).not.toContain(forbidden);
  });

  it('strips event handlers', () => {
    const out = sanitizeCampaignBody('<p onclick="alert(1)" onerror="alert(2)">hi</p>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onerror');
    expect(out).toContain('hi');
  });

  it('strips javascript: and data: URLs', () => {
    const out = sanitizeCampaignBody(
      '<a href="javascript:alert(1)">x</a><img src="data:text/html,<script>alert(1)</script>">'
    );
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text/html');
  });

  it('strips srcset, which the scheme filter does not police', () => {
    const out = sanitizeCampaignBody(
      '<img src="https://ok.example/a.png" srcset="http://evil.example/b.png 2x">'
    );
    expect(out).not.toContain('srcset');
    expect(out).toContain('https://ok.example/a.png');
  });

  it('rejects protocol-relative URLs', () => {
    expect(sanitizeCampaignBody('<a href="//evil.example">x</a>')).not.toContain('//evil.example');
  });

  it('keeps the table layout tags an email actually needs', () => {
    const html = '<table border="0" cellpadding="8" width="600"><tbody><tr>'
      + '<td align="center" bgcolor="#ffffff">Cell</td></tr></tbody></table>';
    const out = sanitizeCampaignBody(html);
    expect(out).toContain('<table');
    expect(out).toContain('<td');
    expect(out).toContain('cellpadding="8"');
    expect(out).toContain('bgcolor="#ffffff"');
  });

  it('keeps safe images and links, and forces rel on links', () => {
    const out = sanitizeCampaignBody(
      '<a href="https://example.com">Book</a><img src="https://cdn.example/x.png" alt="x" width="600">'
    );
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('src="https://cdn.example/x.png"');
    expect(out).toContain('width="600"');
  });

  it('keeps mailto and cid schemes', () => {
    const out = sanitizeCampaignBody('<a href="mailto:a@b.com">mail</a><img src="cid:logo">');
    expect(out).toContain('mailto:a@b.com');
    expect(out).toContain('cid:logo');
  });

  it('cleans dangerous declarations out of inline style attributes', () => {
    const out = sanitizeCampaignBody(
      '<p style="color:red;background:url(http://evil.example/track.gif)">hi</p>'
    );
    expect(out).toContain('color:red');
    expect(out).not.toContain('http://evil.example');
  });

  it('blocks a tracking url() hidden behind &quot; entities', () => {
    // sanitize-html writes `"` inside an attribute as `&quot;`, so the CSS
    // scanner and the recipient's browser disagreed about where strings
    // start: the browser decodes first and reads the apostrophe as ordinary
    // text inside a real string, then fetches the background — while the
    // scanner saw the apostrophe open a string and skipped past the url().
    const out = sanitizeCampaignBody(
      `<p style="font-family:&quot;don't&quot;;background:url(https://evil.example/p.gif)">hi</p>`
    );
    expect(out).not.toContain('evil.example');
  });

  it('blocks a tracking url() hidden behind an escaped quote', () => {
    const out = sanitizeCampaignBody(
      `<p style="--m:\\';background:url(https://evil.example/p.gif)">hi</p>`
    );
    expect(out).not.toContain('evil.example');
  });

  it('keeps a legitimate quoted font stack, re-encoded for the attribute', () => {
    const out = sanitizeCampaignBody(
      `<p style="color:red;font-family:&quot;Helvetica Neue&quot;,sans-serif">hi</p>`
    );
    expect(out).toContain('color:red');
    expect(out).toContain('Helvetica Neue');
    // Re-encoded, so the attribute stays well formed rather than being cut short.
    expect(out).not.toMatch(/style="[^"]*"[^>]*"/);
  });

  it('strips expression() out of an inline style', () => {
    const out = sanitizeCampaignBody('<p style="width:expression(alert(1))">hi</p>');
    expect(out).not.toContain('expression(');
  });

  it('leaves the {{variable}} syntax intact for the render pass', () => {
    const out = sanitizeCampaignBody('<p>Hi {{first_name}}, {{#if company_name}}({{company_name}}){{/if}}</p>');
    expect(out).toContain('{{first_name}}');
    expect(out).toContain('{{#if company_name}}');
    expect(out).toContain('{{/if}}');
  });

  it('is idempotent — a second pass changes nothing', () => {
    const messy = '<p style="color:red" onclick="x()">Hi {{first_name}}</p>'
      + '<script>alert(1)</script><a href="https://e.com">go</a>'
      + '<table><tr><td bgcolor="#eee">c</td></tr></table>';
    const once = sanitizeCampaignBody(messy);
    expect(sanitizeCampaignBody(once)).toBe(once);
  });

  it('rejects a body over the size cap instead of silently truncating', () => {
    const huge = `<p>${'x'.repeat(MAX_BODY_BYTES + 1)}</p>`;
    expect(() => sanitizeCampaignBody(huge)).toThrow(/exceeds/i);
  });

  it('accepts a body just under the cap', () => {
    const big = `<p>${'x'.repeat(MAX_BODY_BYTES - 100)}</p>`;
    expect(() => sanitizeCampaignBody(big)).not.toThrow();
  });
});

describe('sanitizeCampaignCss', () => {
  it('returns empty for empty input', () => {
    expect(sanitizeCampaignCss('').css).toBe('');
    expect(sanitizeCampaignCss(null).css).toBe('');
  });

  it('keeps ordinary declarations', () => {
    const { css } = sanitizeCampaignCss('.btn { color: #fff; padding: 12px 24px; }');
    expect(css).toContain('color: #fff');
    expect(css).toContain('padding: 12px 24px');
  });

  it.each([
    ['@import', '@import url("https://evil.example/x.css"); .a{color:red}'],
    ['expression(', '.a { width: expression(alert(1)); }'],
    ['behavior:', '.a { behavior: url(evil.htc); }'],
    ['javascript:', '.a { background: url(javascript:alert(1)); }'],
  ])('blocks %s', (needle, input) => {
    const { css, warnings } = sanitizeCampaignCss(input);
    expect(css).not.toContain(needle);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('blocks remote url() — stricter than the issue asked for, on purpose', () => {
    // A remote url() in mail CSS is a tracking pixel by another name; images
    // belong in <img> where the scheme filter sees them.
    const { css } = sanitizeCampaignCss('.hero { background: url(https://cdn.example/x.png); }');
    expect(css).not.toContain('https://cdn.example/x.png');
  });

  it('strips embedded markup', () => {
    const { css } = sanitizeCampaignCss('.a{color:red}</style><script>alert(1)</script>');
    expect(css).not.toContain('<script');
    expect(css).not.toContain('</style>');
  });
});
