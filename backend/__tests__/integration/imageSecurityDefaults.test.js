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
  let resolveImageSecurityColumns;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ getImageSecurityDefaults, resolveImageSecurityColumns } =
      require('../../src/routes/adminEvents/helpers'));
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
    // parseInt would have rescued each of these into a valid-looking
    // integer. The settings PUT stores values without validating them, so
    // they can genuinely be in the table.
    ['a numeric prefix with trailing junk', 'default_image_quality', '72oops'],
    ['a fractional quality', 'default_image_quality', 72.5],
    ['a single-element array', 'default_image_quality', [72]],
    ['a fractional fragmentation level', 'default_fragmentation_level', 3.7],
    ['a fragmentation level with trailing junk', 'default_fragmentation_level', '3x'],
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

  describe('double-encoded settings (the settings tab round trip)', () => {
    // GET returns setting_value undecoded and the tab PUTs the whole object
    // back through JSON.stringify, so on SQLite one visit to the tab turns
    // every value it read into a doubly-encoded string. A single parse left
    // a string behind, the type checks rejected it, and the defaults went
    // silently dead again.
    const setRaw = async (key, raw) => {
      await db('app_settings')
        .insert({ setting_key: key, setting_value: raw, setting_type: 'security' })
        .onConflict('setting_key').merge();
    };

    it('reads a double-encoded boolean', async () => {
      await setRaw('enable_canvas_rendering', JSON.stringify(JSON.stringify(true)));
      expect(await getImageSecurityDefaults()).toEqual({ use_canvas_rendering: true });
    });

    it('reads a double-encoded protection level', async () => {
      await setRaw('default_protection_level', JSON.stringify(JSON.stringify('enhanced')));
      expect(await getImageSecurityDefaults()).toEqual({ protection_level: 'enhanced' });
    });

    it('reads a double-encoded integer', async () => {
      await setRaw('default_image_quality', JSON.stringify(JSON.stringify(72)));
      expect(await getImageSecurityDefaults()).toEqual({ image_quality: 72 });
    });

    it('reads a value buried under many saves, not just one', async () => {
      // Each visit to the settings tab used to add a layer, so the depth is
      // however many times someone opened it — not a number to cap.
      let raw = JSON.stringify('maximum');
      for (let i = 0; i < 8; i += 1) raw = JSON.stringify(raw);
      await setRaw('default_protection_level', raw);
      expect(await getImageSecurityDefaults()).toEqual({ protection_level: 'maximum' });
    });

    it('still rejects a malformed value however many times it was encoded', async () => {
      await setRaw('default_image_quality', JSON.stringify(JSON.stringify('72oops')));
      expect(await getImageSecurityDefaults()).toEqual({});
    });
  });

  describe('resolveImageSecurityColumns', () => {
    it('omits every column when neither the request nor the settings supply one', () => {
      expect(resolveImageSecurityColumns({}, {})).toEqual({});
    });

    it('uses the global default when the request says nothing', () => {
      expect(resolveImageSecurityColumns({}, { protection_level: 'maximum' }))
        .toEqual({ protection_level: 'maximum' });
    });

    it('lets an explicit request value win over the global default', () => {
      expect(resolveImageSecurityColumns(
        { protection_level: 'basic' },
        { protection_level: 'maximum' },
      )).toEqual({ protection_level: 'basic' });
    });

    it('keeps an explicit false canvas value instead of reading it as absent', () => {
      const columns = resolveImageSecurityColumns(
        { use_canvas_rendering: false },
        { use_canvas_rendering: true },
      );
      expect(columns.use_canvas_rendering).toBeFalsy();
    });

    it('keeps a zero-ish explicit value rather than falling through', () => {
      // 0 is out of range for the column, but the guard is `!== undefined`,
      // not truthiness — the validator is what rejects out-of-range input.
      expect(resolveImageSecurityColumns({ image_quality: 0 }, { image_quality: 85 }))
        .toEqual({ image_quality: 0 });
    });

    it('resolves each column independently', () => {
      expect(resolveImageSecurityColumns(
        { image_quality: 60 },
        { protection_level: 'enhanced', fragmentation_level: 4 },
      )).toEqual({
        protection_level: 'enhanced',
        image_quality: 60,
        fragmentation_level: 4,
      });
    });

    it('tolerates a missing body, which is what an empty API request looks like', () => {
      expect(resolveImageSecurityColumns(undefined, { image_quality: 90 }))
        .toEqual({ image_quality: 90 });
    });
  });
});
