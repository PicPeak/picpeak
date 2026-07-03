/**
 * Factory tests for the pluggable-tracker registry (#663 Phase 1).
 *
 * Pins the contract that drives `adminDashboard.js` analytics route:
 *  - Returns null for 'none' / 'custom' / unset → route falls back to access_logs.
 *  - Returns an Umami adapter shape for provider='umami'.
 *  - Returns a Rybbit adapter shape for provider='rybbit'.
 *  - Back-compat: when `analytics_tracker_provider` is unset, infers
 *    'umami' from the legacy `analytics_umami_enabled` flag.
 *  - Invalid provider strings fall through to the legacy back-compat path
 *    rather than crashing (defensive).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-tracker-fact-')), 'db.sqlite',
);

const { bootCrmDb } = require('../integration/helpers/crmDb');
const trackers = require('../../src/services/trackers');

let db; let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
}, 30000);

afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(async () => {
  await db('app_settings').del();
});

async function setSetting(key, value) {
  await db('app_settings').insert({
    setting_key: key,
    setting_value: JSON.stringify(value),
    setting_type: 'analytics',
    updated_at: new Date(),
  });
}

describe('resolveAdapter (#663)', () => {
  test('returns null when provider=\'none\'', async () => {
    await setSetting('analytics_tracker_provider', 'none');
    expect(await trackers.resolveAdapter()).toBeNull();
  });

  test('returns null when provider=\'custom\' (no metrics adapter, just a script slot)', async () => {
    await setSetting('analytics_tracker_provider', 'custom');
    expect(await trackers.resolveAdapter()).toBeNull();
  });

  test('back-compat: provider unset + legacy umami_enabled=true → umami adapter', async () => {
    await setSetting('analytics_umami_enabled', true);
    await setSetting('analytics_umami_url', 'https://u.example');
    await setSetting('analytics_umami_website_id', 'w-1');
    await setSetting('analytics_umami_api_key', 'k-1');
    const adapter = await trackers.resolveAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter.provider).toBe('umami');
  });

  test('provider=\'umami\' explicit → umami adapter with stored secrets', async () => {
    await setSetting('analytics_tracker_provider', 'umami');
    await setSetting('analytics_umami_url', 'https://u.example');
    await setSetting('analytics_umami_website_id', 'w-1');
    await setSetting('analytics_umami_api_key', 'k-1');
    const adapter = await trackers.resolveAdapter();
    expect(adapter.provider).toBe('umami');
  });

  test('provider=\'rybbit\' → rybbit adapter with stored secrets', async () => {
    await setSetting('analytics_tracker_provider', 'rybbit');
    await setSetting('analytics_rybbit_url', 'https://r.example');
    await setSetting('analytics_rybbit_website_id', 'r-1');
    await setSetting('analytics_rybbit_api_key', 'rk-1');
    const adapter = await trackers.resolveAdapter();
    expect(adapter.provider).toBe('rybbit');
  });

  test('garbage provider value falls through to legacy back-compat (defensive)', async () => {
    await setSetting('analytics_tracker_provider', 'plausible-not-yet-supported');
    // No legacy umami_enabled → resolves to null (= 'none')
    expect(await trackers.resolveAdapter()).toBeNull();
  });
});
