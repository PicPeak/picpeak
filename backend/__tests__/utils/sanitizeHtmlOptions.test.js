/**
 * sanitize-html 2.18.0 sanitizes the content of a discarded <iframe> again,
 * once per nested <iframe>, and ~1,000 of them overflow the call stack. Every
 * config treats <iframe> as a non-text tag (utils/sanitizeHtmlOptions.js), so
 * its content is dropped instead.
 */
const sanitizeHtml = require('sanitize-html');
const { NON_TEXT_TAGS } = require('../../src/utils/sanitizeHtmlOptions');
const { sanitizeCampaignBody } = require('../../src/services/newsletterService');
const { _internal: { sanitizeBody } } = require('../../src/services/emailIntakeService');

const nested = (n) => '<iframe>'.repeat(n) + 'x';

describe('sanitize-html non-text tags', () => {
  it('keeps sanitize-html\'s own non-text tags', () => {
    expect(NON_TEXT_TAGS).toEqual(expect.arrayContaining(['script', 'style', 'textarea', 'option', 'xmp']));
  });

  it('drops the content of a discarded iframe and keeps what follows it', () => {
    const out = sanitizeHtml('<p>a</p><iframe><b>x</b><script>alert(1)</script></iframe><p>after</p>',
      { nonTextTags: NON_TEXT_TAGS });
    expect(out).toBe('<p>a</p><p>after</p>');
  });

  it('cleans an inbound mail body of deeply nested iframes', () => {
    expect(sanitizeBody(`<p>hello</p>${nested(20000)}`)).toBe('<p>hello</p>');
  });

  it('cleans a newsletter body of deeply nested iframes', () => {
    expect(sanitizeCampaignBody(`<p>hello</p>${nested(5000)}`)).toBe('<p>hello</p>');
  });
});
