/**
 * wrapEmailHtml() chrome is built from branding rows that `settings.edit`
 * writes — a permission that deliberately does NOT include the email
 * templates (email.edit). The company name was interpolated raw into two
 * alt="" attributes and two text positions, the logo URL raw into src="",
 * and eight colour settings raw into <style>, style="" and bgcolor="". A
 * delegated settings editor could therefore put a link, an image or a
 * `</style>` into every transactional mail this install sends.
 *
 * Scanner finding 31a5714a.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');

const COLOR_KEYS = [
  'email_primary_color', 'email_secondary_color', 'email_body_bg_color',
  'email_container_bg_color', 'email_list_bg_color', 'email_body_text_color',
  'email_muted_text_color', 'email_button_text_color',
];

describe('wrapEmailHtml — branding settings are text, not markup', () => {
  let db; let cleanup; let wrapEmailHtml; let upsertAppSetting;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ wrapEmailHtml } = require('../../src/services/emailProcessor'));
    ({ upsertAppSetting } = require('../../src/utils/appSettings'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  async function setBranding(values) {
    await db('app_settings')
      .whereIn('setting_key', ['branding_company_name', 'branding_logo_url', ...COLOR_KEYS])
      .del();
    for (const [key, value] of Object.entries(values)) {
      await upsertAppSetting(key, JSON.stringify(value), 'string');
    }
  }

  it('escapes a company name in the alt attributes and the footer text', async () => {
    await setBranding({
      branding_company_name: '"><a href="https://evil.example">Reset your password</a><img src="x" onerror="alert(1)',
    });
    const html = await wrapEmailHtml('<p>body</p>', 'Subject', 'en');
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).not.toContain('onerror="alert(1)');
    expect(html).toContain('alt="&quot;&gt;&lt;a href=&quot;https://evil.example&quot;&gt;');
    // Both text positions carry the encoded form.
    expect(html.match(/&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;Reset your password&lt;\/a&gt;/g))
      .toHaveLength(4);
  });

  it('escapes a logo URL that tries to close src="" and drops non-http(s) schemes', async () => {
    await setBranding({ branding_logo_url: '/x.png" onerror="alert(1)' });
    let html = await wrapEmailHtml('<p>body</p>', 'Subject', 'en');
    expect(html).not.toContain('onerror="alert(1)');
    expect(html).toContain('src="http://localhost:3000/x.png&quot; onerror=&quot;alert(1)"');

    await setBranding({ branding_logo_url: 'javascript:alert(1)' });
    html = await wrapEmailHtml('<p>body</p>', 'Subject', 'en');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('src="http://localhost:3000/picpeak-logo-transparent.png"');
  });

  it.each(COLOR_KEYS)('%s cannot close the style element or an attribute', async (key) => {
    await setBranding({ [key]: '#fff</style><meta http-equiv="refresh" content="0;url=https://evil.example">' });
    const html = await wrapEmailHtml('<p>body</p>', 'Subject', 'en');
    expect(html).not.toContain('<meta http-equiv="refresh"');
    expect(html.match(/<\/style>/g)).toHaveLength(1);

    await setBranding({ [key]: '#fff" onload="alert(1)' });
    const html2 = await wrapEmailHtml('<p>body</p>', 'Subject', 'en');
    expect(html2).not.toContain('onload="alert(1)');
  });

  it('keeps the output byte-identical for ordinary branding', async () => {
    await setBranding({
      branding_company_name: 'Willow Pine Studio',
      branding_logo_url: '/uploads/logos/logo.png',
      email_primary_color: '#5C8762',
      email_muted_text_color: 'rgb(102, 102, 102)',
    });
    const html = await wrapEmailHtml('<p>body</p>', 'Subject', 'en');
    expect(html).toContain('<img src="http://localhost:3000/uploads/logos/logo.png" alt="Willow Pine Studio" width="180"');
    expect(html).toContain('<p style="color:rgb(102, 102, 102);font-size:14px;margin:5px 0;">Willow Pine Studio</p>');
    expect(html).toContain('bgcolor="#5C8762"');
    expect(html).toContain('Willow Pine Studio. All rights reserved.');
  });
});
