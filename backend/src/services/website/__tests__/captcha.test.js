/**
 * The website's page policy with and without a spam check (issue 2618).
 */
const { websiteCsp, widgetHtml } = require('../captcha');

test('no script on a page without the captcha; exactly the provider\'s paths with it', () => {
  expect(websiteCsp()).toBe('default-src \'self\'; frame-ancestors \'none\'; img-src \'self\' data: https:; media-src \'self\'; style-src \'self\' \'unsafe-inline\' https:; font-src \'self\' https: data:; object-src \'none\'; script-src \'none\'; form-action \'self\'; base-uri \'none\'');
  expect(websiteCsp('friendly')).toContain('script-src https://cdn.jsdelivr.net/npm/@friendlycaptcha/sdk@1.1.5/;');
  expect(websiteCsp('friendly')).toContain('frame-src https://*.frcapi.com');
  expect(websiteCsp('recaptcha')).toContain('script-src https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/;');
  for (const p of [null, 'friendly', 'recaptcha']) {
    expect(websiteCsp(p)).not.toMatch(/'unsafe-inline'[^;]*;[^;]*$|script-src[^;]*'self'|script-src[^;]*unsafe/);
    expect(websiteCsp(p)).toContain('form-action \'self\'');
  }
});

test('the widget escapes its key and pins the SDK with its hashes', () => {
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = widgetHtml({ provider: 'friendly', siteKey: 'K"><x', endpoint: 'global' }, { locale: 'de', esc });
  expect(html).toContain('data-sitekey="K&#34;&#62;&#60;x"');
  expect(html).not.toContain('data-api-endpoint');
  expect(html.match(/integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous"/g)).toHaveLength(2);
});
