/**
 * Gallery info banner (#932).
 *
 * A short note rendered ABOVE the photo grid — the reporter's case is an
 * onboarding hint ("use the menu button to filter"), which is useless in the
 * promo slot down by the footer because the guest has to scroll the whole
 * gallery to reach it.
 *
 * Covers what the migration actually produces on a real engine (the harness
 * runs SQLite) and the inherit/custom/off resolution the gallery render
 * depends on. The resolution is duplicated here rather than imported because
 * it lives in the React layer; the point is to pin the CONTRACT — which
 * source wins for each mode — so a change on either side has to update this
 * file deliberately.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-info-banner-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'info-banner-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

let db;
let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('migration 176 — schema', () => {
  it('adds events.info_mode defaulting to inherit', async () => {
    expect(await db.schema.hasColumn('events', 'info_mode')).toBe(true);

    const [id] = await db('events').insert({
      slug: 'info-default-test',
      event_type: 'wedding',
      event_name: 'Info Default Test',
      event_date: '2026-06-22',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: '/gallery/info-default-test/share',
      share_token: 'info-default-test-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = id?.id ?? id;

    const row = await db('events').where({ id: eventId }).first();
    // A gallery created before anyone configures the feature must inherit,
    // so switching the global default on lights up every existing gallery.
    expect(row.info_mode).toBe('inherit');
    expect(row.info_markdown ?? null).toBeNull();
  });

  it('adds events.info_markdown as nullable text', async () => {
    expect(await db.schema.hasColumn('events', 'info_markdown')).toBe(true);
  });

  it('seeds branding_info_markdown empty, so upgrading shows no banner', async () => {
    const row = await db('app_settings').where({ setting_key: 'branding_info_markdown' }).first();
    expect(row).toBeTruthy();
    expect(JSON.parse(row.setting_value)).toBe('');
    expect(row.setting_type).toBe('branding');
  });
});

// Mirrors GalleryLayout's resolution.
function resolveInfoBanner(event, brandingDefault) {
  const mode = event.info_mode || 'inherit';
  if (mode === 'off') return '';
  if (mode === 'custom') {
    const own = (event.info_markdown || '').trim();
    return (own || brandingDefault || '').trim();
  }
  return (brandingDefault || '').trim();
}

describe('inherit / custom / off resolution', () => {
  const GLOBAL = 'Use the menu button to filter.';

  it('inherit renders the global default', () => {
    expect(resolveInfoBanner({ info_mode: 'inherit' }, GLOBAL)).toBe(GLOBAL);
  });

  it('a missing mode is treated as inherit (rows predating the migration)', () => {
    expect(resolveInfoBanner({}, GLOBAL)).toBe(GLOBAL);
  });

  it('custom renders the event copy instead of the global', () => {
    const own = 'Proofs are watermarked until final delivery.';
    expect(resolveInfoBanner({ info_mode: 'custom', info_markdown: own }, GLOBAL)).toBe(own);
  });

  it('custom with blank copy falls back to the global rather than showing nothing', () => {
    expect(resolveInfoBanner({ info_mode: 'custom', info_markdown: '   ' }, GLOBAL)).toBe(GLOBAL);
  });

  it('off suppresses the banner even when a global default exists', () => {
    expect(resolveInfoBanner({ info_mode: 'off' }, GLOBAL)).toBe('');
  });

  it('off wins over the event own copy too', () => {
    expect(resolveInfoBanner({ info_mode: 'off', info_markdown: 'ignored' }, GLOBAL)).toBe('');
  });

  it('an empty global default means no banner anywhere — the upgrade state', () => {
    expect(resolveInfoBanner({ info_mode: 'inherit' }, '')).toBe('');
    expect(resolveInfoBanner({}, undefined)).toBe('');
  });
});

describe('per-event persistence', () => {
  let eventId;

  beforeAll(async () => {
    const [id] = await db('events').insert({
      slug: 'info-persist-test',
      event_type: 'wedding',
      event_name: 'Info Persist Test',
      event_date: '2026-06-22',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: '/gallery/info-persist-test/share',
      share_token: 'info-persist-test-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = id?.id ?? id;
  });

  it('stores a custom override', async () => {
    await db('events').where({ id: eventId })
      .update({ info_mode: 'custom', info_markdown: '**Heads up** — proofs only.' });

    const row = await db('events').where({ id: eventId }).first();
    expect(row.info_mode).toBe('custom');
    expect(row.info_markdown).toBe('**Heads up** — proofs only.');
  });

  it('switching away from custom clears the stored copy', async () => {
    // Matches the route's normalisation: mode != custom nulls the text so a
    // later switch back to custom can't resurrect stale copy.
    await db('events').where({ id: eventId })
      .update({ info_mode: 'off', info_markdown: null });

    const row = await db('events').where({ id: eventId }).first();
    expect(row.info_mode).toBe('off');
    expect(row.info_markdown).toBeNull();
  });

  it('the promo banner is untouched by info-banner changes', async () => {
    const row = await db('events').where({ id: eventId }).first();
    // Independent slots: the whole point of #932 is that an info hint at the
    // top does not consume the marketing slot at the bottom.
    expect(row.promo_mode).toBe('inherit');
    expect(row.promo_markdown ?? null).toBeNull();
  });
});
