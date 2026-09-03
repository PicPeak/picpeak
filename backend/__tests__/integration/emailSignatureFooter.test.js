/**
 * Global email footer signature (migration 198, issue #1264).
 *
 * The signature is rendered by `wrapEmailHtml` and nowhere else, which is
 * the whole point of the design: every template, preview, test mail and
 * manual send passes through that one wrapper, so none of them needed a
 * per-template change. These tests pin that contract at the wrapper.
 *
 * The load-bearing case is the DISABLED one — an upgraded install must keep
 * a byte-identical footer until an admin opts in.
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('wrapEmailHtml — business-profile signature footer', () => {
  let db;
  let cleanup;
  let wrapEmailHtml;
  let businessProfileService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ wrapEmailHtml } = require('../../src/services/emailProcessor'));
    businessProfileService = require('../../src/services/businessProfileService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('business_profile').where({ id: 1 }).update({
      company_name: null,
      address_line1: null,
      address_line2: null,
      postal_code: null,
      city: null,
      country_code: null,
      country_name: null,
      phone: null,
      mobile: null,
      email: null,
      website: null,
      vat_id: null,
      email_signature_enabled: false,
      email_signature_extra: null,
    });
    businessProfileService.invalidateEmailSignatureCache();
  });

  const fullProfile = {
    company_name: 'Müller Fotografie GmbH',
    address_line1: 'Bahnhofstrasse 1',
    address_line2: 'Postfach 42',
    postal_code: '9494',
    city: 'Schaan',
    country_code: 'li',
    country_name: 'Liechtenstein',
    phone: '+41 79 123 45 67',
    mobile: '+41 78 000 11 22',
    email: 'hello@example.com',
    website: 'example.com',
    vat_id: 'CHE-123.456.789',
    email_signature_enabled: true,
    email_signature_extra: 'Handelsregister Vaduz\nFL-0002.123.456-7',
  };

  async function enable(overrides = {}) {
    await db('business_profile').where({ id: 1 }).update({ ...fullProfile, ...overrides });
    businessProfileService.invalidateEmailSignatureCache();
  }

  it('renders nothing extra when the toggle is off', async () => {
    // Profile fully populated, signature switched OFF: the operator's
    // address must not leak into mail just because they filled in the
    // invoice issuer block.
    await enable({ email_signature_enabled: false });

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    expect(html).not.toContain('Bahnhofstrasse 1');
    expect(html).not.toContain('hello@example.com');
    expect(html).not.toContain('CHE-123.456.789');
  });

  it('produces a byte-identical footer to a no-profile install when disabled', async () => {
    const withEmptyProfile = await wrapEmailHtml('<p>Body</p>', 'Subject');
    await enable({ email_signature_enabled: false });
    const withDisabledSignature = await wrapEmailHtml('<p>Body</p>', 'Subject');

    expect(withDisabledSignature).toBe(withEmptyProfile);
  });

  it('renders address, contacts, VAT id and the legal line when enabled', async () => {
    await enable();

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    expect(html).toContain('Müller Fotografie GmbH');
    expect(html).toContain('Bahnhofstrasse 1');
    expect(html).toContain('Postfach 42');
    // "LI-9494 Schaan / Liechtenstein" — same shape as the PDF issuer block.
    expect(html).toContain('LI-9494 Schaan / Liechtenstein');
    expect(html).toContain('VAT ID: CHE-123.456.789');
    expect(html).toContain('Handelsregister Vaduz<br />FL-0002.123.456-7');
  });

  it('links phone, mobile, email and website with safe schemes', async () => {
    await enable();

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    // Separators stripped from the tel: href, kept in the visible text.
    expect(html).toContain('href="tel:+41791234567"');
    expect(html).toContain('href="tel:+41780001122"');
    expect(html).toContain('href="mailto:hello@example.com"');
    // A bare hostname is promoted to https:// rather than left relative.
    expect(html).toContain('href="https://example.com"');
  });

  it('keeps an already-absolute website URL as typed', async () => {
    await enable({ website: 'http://legacy.example.org/studio' });

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    expect(html).toContain('href="http://legacy.example.org/studio"');
  });

  it('neutralises a javascript: website into an inert https URL', async () => {
    await enable({ website: 'javascript:alert(1)' });

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://javascript:alert(1)"');
  });

  it('HTML-escapes every signature field', async () => {
    await enable({
      company_name: '<script>alert(1)</script>',
      address_line1: 'Rue "des" Fleurs & Co',
      vat_id: '<img src=x onerror=alert(1)>',
      email_signature_extra: '</p><script>alert(2)</script>',
    });

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    // Escaped, so the markup is inert text — the tags never open.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Rue &quot;des&quot; Fleurs &amp; Co');
  });

  it('does not repeat the branding company name', async () => {
    // Footer already prints the branding name; the profile name is only
    // added when the operator gave a different legal name.
    await db('app_settings')
      .insert({ setting_key: 'branding_company_name', setting_value: JSON.stringify('Müller Fotografie GmbH'), setting_type: 'branding' })
      .onConflict('setting_key')
      .merge();
    await enable();

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    expect(html.match(/Müller Fotografie GmbH/g).length).toBe(
      // header alt, footer alt, footer name line, copyright line — the
      // signature must not add a fifth.
      (await wrapEmailHtml('<p>Body</p>', 'Subject', 'en')).match(/Müller Fotografie GmbH/g).length
    );
    expect(html.match(/Müller Fotografie GmbH/g).length).toBe(4);

    await db('app_settings').where({ setting_key: 'branding_company_name' }).del();
  });

  it('uses the German VAT label for a German mail', async () => {
    await enable();

    const de = await wrapEmailHtml('<p>Body</p>', 'Subject', 'de');
    const en = await wrapEmailHtml('<p>Body</p>', 'Subject', 'en');

    expect(de).toContain('USt-IdNr.: CHE-123.456.789');
    expect(en).toContain('VAT ID: CHE-123.456.789');
  });

  it('omits empty fields instead of rendering blank rows', async () => {
    await enable({
      address_line2: null, mobile: null, website: null, vat_id: null, email_signature_extra: null,
    });

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    expect(html).toContain('hello@example.com');
    expect(html).not.toContain('VAT ID:');
    expect(html).not.toMatch(/&middot;\s*&middot;/);
  });

  it('renders no signature block when enabled but the profile is blank', async () => {
    await db('business_profile').where({ id: 1 }).update({ email_signature_enabled: true });
    businessProfileService.invalidateEmailSignatureCache();

    const html = await wrapEmailHtml('<p>Body</p>', 'Subject');

    // The signature <div> is the only element carrying this margin.
    expect(html).not.toContain('<div style="margin:15px 0 5px;');
  });

  it('leaves the plain-text part free of signature markup', async () => {
    const { htmlToText } = require('../../src/services/emailProcessor');
    await enable();

    const text = htmlToText(await wrapEmailHtml('<p>Body</p>', 'Subject'));

    expect(text).toContain('Bahnhofstrasse 1');
    expect(text).not.toContain('<p');
    expect(text).not.toContain('style=');
    expect(text).not.toContain('&middot;');
    // The separator survives as a real character, not an entity.
    expect(text).toContain('Bahnhofstrasse 1 \u00b7 Postfach 42');
  });
});
