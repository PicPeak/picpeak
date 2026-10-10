/**
 * The PDF theme service reads the Branding theme, so a document whose theme
 * sets no accent takes the brand's filled accent (services/pdf/theme.js
 * brandColors). Exercised through the service, not the pure model.
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('pdfThemeService — brand accent', () => {
  let db;
  let cleanup;
  let pdfThemeService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    pdfThemeService = require('../../src/services/pdfThemeService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  const setBrandAccent = async (accentDarkColor) => {
    await db('app_settings').where({ setting_key: 'theme_config' }).del();
    await db('app_settings').insert({ setting_key: 'theme_config', setting_value: JSON.stringify({ accentDarkColor }), setting_type: 'theme', updated_at: new Date() });
  };

  it('resolves and lists the brand accent for documents that set none', async () => {
    await setBrandAccent('#014E4E');
    expect((await pdfThemeService.resolveTheme('quote')).colors.accent).toBe('#014e4e');
    expect((await pdfThemeService.listThemes()).brandColors).toEqual({ accent: '#014e4e' });
  });

  it('keeps the built-in black for a brand colour too pale for paper', async () => {
    await setBrandAccent('#ffe066');
    expect((await pdfThemeService.resolveTheme('invoice')).colors.accent).toBe('#000000');
  });
});
