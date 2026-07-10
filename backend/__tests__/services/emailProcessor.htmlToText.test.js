/**
 * Unit tests for emailProcessor.htmlToText.
 *
 * Regression: when a template ships without a body_text, sendTemplateEmail
 * used `htmlBody.replace(/<[^>]*>/g, '')` to derive the plain-text fallback.
 * That regex strips angle-bracket tags but leaves the *contents* of <style>
 * and <script> blocks intact — so any HTML wrapped by wrapEmailHtml() (which
 * embeds a 100+ line <style> block) produced a "plain-text" email starting
 * with `body { margin: 0; padding: 0; … }`. htmlToText fixes that.
 */

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const { htmlToText } = require('../../src/services/emailProcessor');

describe('htmlToText', () => {
  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });

  it('strips <style> blocks and their contents', () => {
    const html = '<html><head><style>body { margin: 0; color: red; }</style></head><body>Hello</body></html>';
    const out = htmlToText(html);
    expect(out).toBe('Hello');
    expect(out).not.toMatch(/margin/);
    expect(out).not.toMatch(/color/);
  });

  it('strips <script> blocks and their contents', () => {
    const html = '<body><script>alert("x")</script>Hi</body>';
    expect(htmlToText(html)).toBe('Hi');
  });

  it('converts <br> tags to newlines', () => {
    expect(htmlToText('a<br>b<br />c<BR/>d')).toBe('a\nb\nc\nd');
  });

  it('keeps a paragraph break between adjacent <p> tags', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
  });

  it('decodes the common HTML entities', () => {
    expect(htmlToText('Tom &amp; Jerry &lt;3 &quot;hi&quot;'))
      .toBe('Tom & Jerry <3 "hi"');
  });

  it('handles a fully-wrapped email body without leaking CSS rules', () => {
    // Shape mirrors what wrapEmailHtml() produces: a <style> block with many
    // CSS rules followed by the actual content.
    const wrapped = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 0; font-family: sans-serif; background-color: #f5f5f5; }
    .email-container { max-width: 600px; }
    .button { background-color: #5C8762; color: white !important; }
  </style>
</head>
<body>
  <h2>Galerie erfolgreich erstellt</h2>
  <p>Liebe(r) Natalie,</p>
</body>
</html>`;
    const out = htmlToText(wrapped);
    expect(out).toContain('Galerie erfolgreich erstellt');
    expect(out).toContain('Liebe(r) Natalie');
    expect(out).not.toMatch(/margin/);
    expect(out).not.toMatch(/font-family/);
    expect(out).not.toMatch(/background-color/);
    expect(out).not.toMatch(/\.button/);
  });
});
