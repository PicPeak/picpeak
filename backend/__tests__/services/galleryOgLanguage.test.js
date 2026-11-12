/**
 * The link-preview pages speak the instance's default language (issue 2489).
 *
 * The gallery preview's description, link text and <html lang> were English
 * whatever Settings → General → Default language said, so a German studio's
 * WhatsApp preview read "Photo gallery from … on 10 November 2026." They now
 * follow general_default_language, falling back to English for a language the
 * previews have no text for.
 */

process.env.FRONTEND_URL = 'https://gallery.example';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const DAY = 24 * 3600 * 1000;

describe('link previews follow the default language', () => {
  let db; let cleanup; let og; let TEXT; let normaliseLanguage;

  const setSetting = async (key, value) => {
    const encoded = JSON.stringify(value);
    const row = await db('app_settings').where({ setting_key: key }).first();
    if (row) await db('app_settings').where({ setting_key: key }).update({ setting_value: encoded });
    else await db('app_settings').insert({ setting_key: key, setting_value: encoded, setting_type: 'general' });
  };
  const clearSetting = (key) => db('app_settings').where({ setting_key: key }).del();

  const addEvent = (slug, extra = {}) => db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: 'Sommerfest',
    event_date: '2026-11-10',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    require_password: 1,
    share_link: `/gallery/${slug}/share`,
    share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
    ...extra,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    // After bootCrmDb: these load database/db, which must bind to the
    // fixture's database.
    og = require('../../src/services/galleryOgService');
    ({ TEXT, normaliseLanguage } = require('../../src/services/ogText'));
    await addEvent('og-lang');
    await addEvent('og-lang-nodate', { event_date: null });
    await clearSetting('branding_company_tagline');
    await setSetting('general_date_format', { format: 'DD.MM.YYYY', locale: 'de-DE' });
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('stays English when no default language is set', async () => {
    await clearSetting('general_default_language');
    const meta = await og.buildOgMetadata('og-lang', '/gallery/og-lang');
    expect(meta.description).toBe('Photo gallery from Sommerfest on 10.11.2026.');
    const html = og.renderOgHtml(meta);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta property="og:locale" content="en_US" />');
    expect(html).toContain('>View gallery</a>');
  });

  it('writes the German preview for a German instance', async () => {
    await setSetting('general_default_language', 'de');
    const meta = await og.buildOgMetadata('og-lang', '/gallery/og-lang');
    expect(meta.description).toBe('Fotogalerie: Sommerfest vom 10.11.2026.');
    const html = og.renderOgHtml(meta);
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('<meta property="og:locale" content="de_DE" />');
    expect(html).toContain('>Galerie ansehen</a>');

    expect((await og.buildOgMetadata('og-lang-nodate', '/gallery/og-lang-nodate')).description)
      .toBe('Fotogalerie: Sommerfest.');
    expect((await og.buildOgMetadata('no-such-gallery', '/gallery/no-such-gallery')).description)
      .toBe('Fotogalerie, geteilt mit PicPeak.');
  });

  it('names the month in the instance language for a long date format', async () => {
    await setSetting('general_date_format', 'PPP');
    await setSetting('general_default_language', 'fr');
    expect((await og.buildOgMetadata('og-lang', '/gallery/og-lang')).description)
      .toBe('Galerie photo de Sommerfest du 10 novembre 2026.');
    await setSetting('general_default_language', 'de');
    expect((await og.buildOgMetadata('og-lang', '/gallery/og-lang')).description)
      .toBe('Fotogalerie: Sommerfest vom 10. November 2026.');
    // A numeric format keeps its configured order: the language only names
    // months, it never turns 11/10 into 10/11.
    await setSetting('general_date_format', { format: 'MM/DD/YYYY', locale: 'en-US' });
    await setSetting('general_default_language', 'fr');
    expect((await og.buildOgMetadata('og-lang', '/gallery/og-lang')).description)
      .toBe('Galerie photo de Sommerfest du 11/10/2026.');
    await setSetting('general_date_format', { format: 'DD.MM.YYYY', locale: 'de-DE' });
  });

  it('falls back to English for a language the previews do not have', async () => {
    await setSetting('general_default_language', 'xx');
    const meta = await og.buildOgMetadata('og-lang', '/gallery/og-lang');
    expect(meta.description).toBe('Photo gallery from Sommerfest on 10.11.2026.');
    expect(og.renderOgHtml(meta)).toContain('<html lang="en">');
  });

  it('keeps the tagline ahead of the generic text', async () => {
    await setSetting('general_default_language', 'de');
    await setSetting('branding_company_tagline', 'Hochzeitsfotografie');
    expect((await og.buildOgMetadata('no-such-gallery', '/gallery/no-such-gallery')).description)
      .toBe('Hochzeitsfotografie');
    await clearSetting('branding_company_tagline');
  });

  it('has every text in every language', () => {
    const keys = Object.keys(TEXT.en).sort();
    for (const [language, texts] of Object.entries(TEXT)) {
      expect([language, Object.keys(texts).sort()]).toEqual([language, keys]);
    }
    expect(normaliseLanguage('de-DE')).toBe('de');
    expect(normaliseLanguage(null)).toBe('en');
  });
});
