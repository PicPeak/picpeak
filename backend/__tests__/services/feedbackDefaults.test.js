/**
 * Global guest-feedback defaults (#1044).
 *
 * Before this module the creation defaults lived in four places that had
 * already drifted: the admin create route's destructuring defaults, the v1
 * create route's hard-coded insert (which omitted `allow_reactions`
 * entirely), getEventFeedbackSettings()'s no-row fallback, and the migration
 * column defaults. Pinned here:
 *
 *  - with no app_settings rows, the built-in fallbacks apply (so installs
 *    that never open Settings > Events keep behaving exactly as before)
 *  - a stored global overrides its fallback, whether it was written as a JSON
 *    boolean, a bare "true"/"false" string, or SQLite's 0/1
 *  - garbage in a settings row falls back rather than writing null into a
 *    boolean column
 *  - an explicitly-sent body value always beats the global
 *  - keybind_mode only accepts the known schemes
 *  - getEventFeedbackSettings()'s no-row fallback reads the same globals
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-feedback-defaults-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'feedback-defaults-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const {
  FEEDBACK_TOGGLES,
  resolveEventFeedbackDefaults,
  applyFeedbackDefaults,
} = require('../../src/services/feedbackDefaults');
const feedbackService = require('../../src/services/feedbackService');

let db;
let cleanup;

async function setGlobal(key, value) {
  await db('app_settings').where('setting_key', key).delete();
  await db('app_settings').insert({
    setting_key: key,
    setting_value: value,
    setting_type: 'general',
    updated_at: new Date().toISOString(),
  });
}

async function clearGlobals() {
  await db('app_settings').where('setting_key', 'like', 'event_default_%').delete();
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

beforeEach(async () => {
  await clearGlobals();
});

describe('resolveEventFeedbackDefaults (#1044)', () => {
  it('falls back to the built-ins when nothing is configured', async () => {
    const defaults = await resolveEventFeedbackDefaults();
    expect(defaults).toEqual({
      allow_ratings: true,
      allow_likes: true,
      allow_favorites: true,
      allow_comments: true,
      allow_reactions: true,
      // Colour labels are opt-in so no existing gallery grows a colour bar
      // on upgrade.
      allow_color_labels: false,
      keybind_mode: 'colors',
    });
  });

  it('covers every toggle the UI shows — no type can be silently missing', async () => {
    const defaults = await resolveEventFeedbackDefaults();
    for (const toggle of FEEDBACK_TOGGLES) {
      expect(defaults).toHaveProperty(toggle.column);
    }
  });

  it('lets a stored global override its fallback', async () => {
    await setGlobal('event_default_allow_comments', JSON.stringify(false));
    await setGlobal('event_default_allow_color_labels', JSON.stringify(true));

    const defaults = await resolveEventFeedbackDefaults();
    expect(defaults.allow_comments).toBe(false);
    expect(defaults.allow_color_labels).toBe(true);
    expect(defaults.allow_likes).toBe(true); // untouched
  });

  it('accepts the value shapes older writers left behind', async () => {
    await setGlobal('event_default_allow_likes', 'false'); // bare string, not JSON-quoted
    await setGlobal('event_default_allow_ratings', '0'); // SQLite boolean
    const defaults = await resolveEventFeedbackDefaults();
    expect(defaults.allow_likes).toBe(false);
    expect(defaults.allow_ratings).toBe(false);
  });

  it('falls back rather than writing garbage into a boolean column', async () => {
    await setGlobal('event_default_allow_favorites', 'not-a-boolean');
    const defaults = await resolveEventFeedbackDefaults();
    expect(defaults.allow_favorites).toBe(true);
  });

  it('only accepts known keybind schemes', async () => {
    await setGlobal('event_default_keybind_mode', JSON.stringify('lightroom'));
    expect((await resolveEventFeedbackDefaults()).keybind_mode).toBe('lightroom');

    await setGlobal('event_default_keybind_mode', JSON.stringify('vim'));
    expect((await resolveEventFeedbackDefaults()).keybind_mode).toBe('colors');
  });
});

describe('applyFeedbackDefaults (#1044)', () => {
  const globals = {
    allow_ratings: true,
    allow_likes: true,
    allow_favorites: true,
    allow_comments: true,
    allow_reactions: true,
    allow_color_labels: false,
    keybind_mode: 'colors',
  };

  it('inherits every value the caller omitted', () => {
    expect(applyFeedbackDefaults({}, globals)).toEqual(globals);
    expect(applyFeedbackDefaults(undefined, globals)).toEqual(globals);
  });

  it('lets an explicit body value win — including an explicit false', () => {
    const resolved = applyFeedbackDefaults(
      { allow_likes: false, allow_color_labels: true, keybind_mode: 'lightroom' },
      globals,
    );
    expect(resolved.allow_likes).toBe(false);
    expect(resolved.allow_color_labels).toBe(true);
    expect(resolved.keybind_mode).toBe('lightroom');
    expect(resolved.allow_ratings).toBe(true); // still inherited
  });

  it('ignores an unknown keybind mode from the body', () => {
    expect(applyFeedbackDefaults({ keybind_mode: 'emacs' }, globals).keybind_mode).toBe('colors');
  });

  it('does not mutate the globals object it was handed', () => {
    const snapshot = { ...globals };
    applyFeedbackDefaults({ allow_likes: false }, globals);
    expect(globals).toEqual(snapshot);
  });
});

describe('getEventFeedbackSettings no-row fallback (#1044)', () => {
  it('reads the same globals instead of a fourth hard-coded copy', async () => {
    await setGlobal('event_default_allow_comments', JSON.stringify(false));
    await setGlobal('event_default_allow_color_labels', JSON.stringify(true));

    // An event id with no event_feedback_settings row.
    const settings = await feedbackService.getEventFeedbackSettings(999999);
    expect(settings.feedback_enabled).toBe(false); // no row still means feedback off
    expect(settings.allow_comments).toBe(false);
    expect(settings.allow_color_labels).toBe(true);
    expect(settings.keybind_mode).toBe('colors');
  });
});
