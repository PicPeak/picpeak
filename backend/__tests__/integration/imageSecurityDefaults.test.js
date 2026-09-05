/**
 * Image-security settings applied as creation defaults (#1296).
 *
 * Four controls in Settings → Image security were written, reloaded and
 * rendered as toggles, and read by nothing:
 *
 *   default_protection_level, default_image_quality,
 *   enable_canvas_rendering, default_fragmentation_level
 *
 * Each maps onto an `events` column migration 038 already created, and each
 * is labelled "… by default". `enable_devtools_protection` was the only one
 * of the five ever wired.
 *
 * The load-bearing constraint is that this is CREATION-time only. Applying
 * these to existing events would silently change live galleries on upgrade —
 * an install with enable_canvas_rendering already on would flip every grid to
 * canvas rendering, which is the memory profile under investigation in #1287.
 */

const { bootCrmDb } = require('./helpers/crmDb');

describe('image-security creation defaults', () => {
  let db;
  let cleanup;
  let getImageSecurityDefaults;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ getImageSecurityDefaults } = require('../../src/routes/adminEvents/helpers'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  const setSetting = async (key, value) => {
    await db('app_settings')
      .insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'security' })
      .onConflict('setting_key')
      .merge();
  };

  beforeEach(async () => {
    await db('app_settings').whereIn('setting_key', [
      'default_protection_level', 'default_image_quality',
      'enable_canvas_rendering', 'default_fragmentation_level',
    ]).del();
  });

  it('returns nothing when no settings are configured', async () => {
    // Every key absent must fall through to the column defaults, which is
    // exactly the behaviour before this existed.
    expect(await getImageSecurityDefaults()).toEqual({});
  });

  it('maps each setting onto its events column', async () => {
    await setSetting('default_protection_level', 'enhanced');
    await setSetting('default_image_quality', 72);
    await setSetting('enable_canvas_rendering', true);
    await setSetting('default_fragmentation_level', 5);

    expect(await getImageSecurityDefaults()).toEqual({
      protection_level: 'enhanced',
      image_quality: 72,
      use_canvas_rendering: true,
      fragmentation_level: 5,
    });
  });

  it('carries a false canvas setting through, rather than dropping it', async () => {
    // `false` is a real choice — dropping it as falsy would leave the column
    // default in place and make "off" unreachable.
    await setSetting('enable_canvas_rendering', false);
    expect(await getImageSecurityDefaults()).toEqual({ use_canvas_rendering: false });
  });

  it.each([
    ['an unknown protection level', 'default_protection_level', 'paranoid'],
    ['a non-enum protection level', 'default_protection_level', 42],
    ['image quality above 100', 'default_image_quality', 250],
    ['image quality of zero', 'default_image_quality', 0],
    ['a non-numeric quality', 'default_image_quality', 'high'],
    ['fragmentation above the range', 'default_fragmentation_level', 99],
    ['a non-boolean canvas value', 'enable_canvas_rendering', 'yes'],
  ])('ignores %s and falls through to the column default', async (_label, key, value) => {
    await setSetting(key, value);
    expect(await getImageSecurityDefaults()).toEqual({});
  });

  it('applies only the keys that are configured', async () => {
    await setSetting('default_protection_level', 'maximum');
    expect(await getImageSecurityDefaults()).toEqual({ protection_level: 'maximum' });
  });

  it('never throws, so a settings failure cannot block event creation', async () => {
    await setSetting('default_image_quality', { nonsense: true });
    await expect(getImageSecurityDefaults()).resolves.toEqual({});
  });
});
