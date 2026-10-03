/**
 * theme_config is persisted by PUT /api/admin/settings/theme (settings.edit)
 * with no schema, and fetchBrandingContext copied each palette value into
 * branding.colors on a truthiness check alone. Those values become CSS custom
 * properties inside the public site's <style> element (server.js), so a
 * `</style>` stored as a "colour" was HTML on the unauthenticated origin.
 * Only values matching the colour grammar may replace a default now.
 *
 * Scanner finding fb8142a9.
 */
jest.mock('../../src/database/db', () => ({ db: jest.fn(), logActivity: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { db } = require('../../src/database/db');
const { getPublicSitePayload, clearPublicSiteCache } = require('../../src/services/publicSiteService');

const publicSiteRows = [
  { setting_key: 'general_public_site_enabled', setting_value: 'true' },
  { setting_key: 'general_public_site_html', setting_value: JSON.stringify('<h1>{{company_name}}</h1>') },
  { setting_key: 'general_public_site_custom_css', setting_value: JSON.stringify('') },
];

async function colorsFor(themeConfig) {
  clearPublicSiteCache();
  db.mockImplementationOnce(() => ({ whereIn: () => Promise.resolve(publicSiteRows) }));
  db.mockImplementationOnce(() => ({ whereIn: () => Promise.resolve([
    { setting_key: 'theme_config', setting_value: JSON.stringify(themeConfig) },
  ]) }));
  const payload = await getPublicSitePayload({ bypassCache: true });
  return payload.branding.colors;
}

const DEFAULTS = {
  primary: '#16a34a', accent: '#0f766e', accentDark: '#16a34a', background: '#f4fbf6',
  surface: '#ffffff', elevated: '#f5f5f5', border: '#e5e5e5', text: '#0f172a', mutedText: '#737373',
};

// theme_config key → branding.colors slot
const SLOTS = {
  primaryColor: 'primary', accentColor: 'accent', accentDarkColor: 'accentDark',
  backgroundColor: 'background', surfaceColor: 'surface', elevatedColor: 'elevated',
  surfaceBorderColor: 'border', textColor: 'text', mutedTextColor: 'mutedText',
};

describe('publicSiteService palette validation', () => {
  it.each(Object.entries(SLOTS))('%s falls back to the default when it is not a colour', async (key, slot) => {
    const colors = await colorsFor({
      [key]: 'red;}</style><meta http-equiv="refresh" content="0;url=https://evil.example">',
    });
    expect(colors[slot]).toBe(DEFAULTS[slot]);
    expect(JSON.stringify(colors)).not.toContain('<');
  });

  it.each([
    ['statement injection', '#fff; background:url(https://evil.example/x)'],
    ['quote', '#fff" onload="alert(1)'],
    ['array', ['#fff']],
    ['object', { primary: '#fff' }],
    ['number', 16777215],
    ['boolean', true],
  ])('rejects a %s in primaryColor', async (_label, value) => {
    const colors = await colorsFor({ primaryColor: value });
    expect(colors.primary).toBe(DEFAULTS.primary);
  });

  it('accepts every supported colour form', async () => {
    const colors = await colorsFor({
      primaryColor: '#014E4E',
      accentColor: 'rgb(1, 124, 124)',
      backgroundColor: 'rgba(13,13,13,0.9)',
      textColor: 'hsl(0 0% 92%)',
      surfaceColor: '#1114',
      elevatedColor: '#18222280',
      surfaceBorderColor: 'transparent',
      mutedTextColor: 'white',
    });
    expect(colors.primary).toBe('#014E4E');
    expect(colors.accent).toBe('rgb(1, 124, 124)');
    expect(colors.background).toBe('rgba(13,13,13,0.9)');
    expect(colors.text).toBe('hsl(0 0% 92%)');
    expect(colors.surface).toBe('#1114');
    expect(colors.elevated).toBe('#18222280');
    expect(colors.border).toBe('transparent');
    expect(colors.mutedText).toBe('white');
  });

  it('still derives accentDark from a valid primaryColor when accentDarkColor is absent or invalid', async () => {
    expect((await colorsFor({ primaryColor: '#5C8762' })).accentDark).toBe('#5C8762');
    expect((await colorsFor({ primaryColor: '#5C8762', accentDarkColor: '</style>' })).accentDark).toBe('#5C8762');
  });

  it('ignores unknown keys', async () => {
    const colors = await colorsFor({ primaryColor: '#5C8762', evilColor: '</style>' });
    expect(colors).toEqual({ ...DEFAULTS, primary: '#5C8762', accentDark: '#5C8762' });
  });
});
