'use strict';

/**
 * Cross-engine .picpeak restore policy (#1041): a SQLite archive restored onto
 * a PostgreSQL instance — the official small-install → full-stack upgrade
 * path — now allowed by validateManifest's direction rule instead of the
 * former CLI-only allowEngineSwitch flag. The coercion engine itself
 * (typedColumnsFor / epochToIso / coerceForTargetEngine) landed with #1039;
 * these tests pin the direction policy and the coercion's cross-engine
 * value-correctness.
 *
 * Ungated: validateManifest direction rules and the pure coercion units.
 * The reverse direction (pg backup onto a sqlite instance) staying blocked is
 * pinned by picpeakRoundtrip.test.js, which runs on the real sqlite harness.
 *
 * Gated on PICPEAK_PG_TEST_URL (same contract as picpeakRestorePg.test.js):
 * sqlite-shaped NDJSON rows land in real Postgres with correct stored VALUES,
 * not just row counts, e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:pw@127.0.0.1:7102/picpeak_xengine_test" \
 *     npx jest __tests__/integration/picpeakCrossEngine.test.js
 */
const knexLib = require('knex');

describe('validateManifest cross-engine direction (pg target)', () => {
  let validateManifest;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../knexfile', () => ({ client: 'pg' }));
    // validateManifest wraps its knex_migrations lookup in try/catch — a
    // throwing stub simply skips the forward-only check, which is not under
    // test here.
    jest.doMock('../../src/database/db', () => ({ db: () => { throw new Error('stub'); } }));
    ({ validateManifest } = require('../../src/services/picpeakImportService'));
  });

  afterAll(() => {
    jest.dontMock('../../src/database/db');
    jest.dontMock('../../knexfile');
    jest.resetModules();
  });

  it('allows a sqlite backup onto a pg instance (upgrade direction)', async () => {
    const blockers = await validateManifest({
      kind: 'picpeak-backup', format: 1, database: { engine: 'sqlite' }, tables: {},
    });
    expect(blockers.filter((b) => /engine/i.test(b))).toHaveLength(0);
  });

  it('still allows same-engine pg → pg', async () => {
    const blockers = await validateManifest({
      kind: 'picpeak-backup', format: 1, database: { engine: 'pg' }, tables: {},
    });
    expect(blockers.filter((b) => /engine/i.test(b))).toHaveLength(0);
  });
});

describe('epochToIso (landed with #1039)', () => {
  let epochToIso;

  beforeAll(() => {
    jest.resetModules();
    ({ epochToIso } = require('../../src/services/picpeakImportService'));
  });

  it('converts epoch milliseconds', () => {
    expect(epochToIso(1723400000000)).toBe('2024-08-11T18:13:20.000Z');
  });

  it('converts epoch SECONDS to the same instant, not January 1970', () => {
    expect(epochToIso(1723400000)).toBe('2024-08-11T18:13:20.000Z');
  });

  it('converts numeric strings', () => {
    expect(epochToIso('1723400000000')).toBe('2024-08-11T18:13:20.000Z');
  });

  it('passes non-numeric values through untouched', () => {
    expect(epochToIso('2026-08-12 10:00:00')).toBe('2026-08-12 10:00:00');
  });
});

describe('coerceForTargetEngine on sqlite-shaped rows', () => {
  let coerceForTargetEngine;

  beforeAll(() => {
    jest.resetModules();
    ({ coerceForTargetEngine } = require('../../src/services/picpeakImportService'));
  });

  const types = { timestamps: ['created_at', 'expires_at'], booleans: ['is_active'] };

  it('coerces 0/1 booleans and epoch timestamps, leaves date strings alone', () => {
    const [row] = coerceForTargetEngine(
      [{ id: 1, is_active: 1, created_at: 1723400000000, expires_at: '2026-09-01 12:00:00' }],
      types
    );
    expect(row.is_active).toBe(true);
    expect(row.created_at).toBe('2024-08-11T18:13:20.000Z');
    expect(row.expires_at).toBe('2026-09-01 12:00:00'); // pg parses this natively
  });

  it('coerces falsy variants and passes null/empty through', () => {
    const [row] = coerceForTargetEngine(
      [{ is_active: 0, created_at: null, expires_at: '' }],
      types
    );
    expect(row.is_active).toBe(false);
    expect(row.created_at).toBeNull();
    expect(row.expires_at).toBe('');
  });
});

// ── Real-Postgres integration (gated) ────────────────────────────────────────
const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

maybe('sqlite-shaped rows land correctly in real Postgres', () => {
  let pgDb;
  let svc;

  beforeAll(async () => {
    pgDb = knexLib({ client: 'pg', connection: PG_URL });
    await pgDb.raw('DROP TABLE IF EXISTS xengine_events, xengine_settings CASCADE');
    await pgDb.schema.createTable('xengine_events', (t) => {
      t.increments('id');
      t.string('slug');
      t.boolean('is_active').defaultTo(true);
      t.boolean('allow_downloads').defaultTo(true);
      t.timestamp('created_at');
      t.timestamp('expires_at');
    });
    await pgDb.schema.createTable('xengine_settings', (t) => {
      t.increments('id');
      t.string('setting_key').notNullable().unique();
      t.jsonb('setting_value');
    });

    jest.resetModules();
    jest.doMock('../../knexfile', () => ({ client: 'pg' }));
    jest.doMock('../../src/database/db', () => ({ db: pgDb }));
    svc = require('../../src/services/picpeakImportService');
  });

  afterAll(async () => {
    jest.dontMock('../../src/database/db');
    jest.dontMock('../../knexfile');
    if (pgDb) {
      await pgDb.raw('DROP TABLE IF EXISTS xengine_events, xengine_settings CASCADE');
      await pgDb.destroy();
    }
  });

  it('typedColumnsFor classifies boolean and timestamp columns via columnInfo()', async () => {
    const types = await svc.typedColumnsFor(pgDb, 'xengine_events');
    expect(types.booleans.sort()).toEqual(['allow_downloads', 'is_active']);
    expect(types.timestamps.sort()).toEqual(['created_at', 'expires_at']);
  });

  it('inserts a sqlite archive row (0/1 booleans, epoch dates, json text) with correct stored values', async () => {
    // Exactly what a sqlite-created .picpeak carries: integers for booleans,
    // epoch numbers for #485-shape timestamps (ms here, seconds covered by the
    // epochToIso unit), a "YYYY-MM-DD HH:MM:SS" string for clean ones, and
    // json columns as TEXT (the crossEngine path skips serialiseJsonColumns —
    // the text is already what pg wants).
    const epoch = 1723400000000;
    const eventRows = [
      { id: 1, slug: 'wedding', is_active: 1, allow_downloads: 0, created_at: epoch, expires_at: '2026-09-01 12:00:00' },
    ];
    const settingRows = [{ id: 1, setting_key: 'brand', setting_value: '{"name":"PicPeak","dark":true}' }];

    await pgDb.transaction(async (trx) => {
      const evTypes = await svc.typedColumnsFor(trx, 'xengine_events');
      await trx.batchInsert('xengine_events', svc.coerceForTargetEngine(eventRows, evTypes), 100);
      const stTypes = await svc.typedColumnsFor(trx, 'xengine_settings');
      await trx.batchInsert('xengine_settings', svc.coerceForTargetEngine(settingRows, stTypes), 100);
    });

    const ev = await pgDb('xengine_events').where({ id: 1 }).first();
    expect(ev.is_active).toBe(true);          // 1 → true, not backwards (#1028 class)
    expect(ev.allow_downloads).toBe(false);   // 0 → false
    expect(new Date(ev.created_at).getTime()).toBe(epoch);
    expect(new Date(ev.expires_at).toISOString().slice(0, 10)).toBe('2026-09-01');

    const st = await pgDb('xengine_settings').where({ id: 1 }).first();
    // jsonb parsed back by the driver — value intact, no double encoding.
    expect(st.setting_value).toEqual({ name: 'PicPeak', dark: true });
  });

  it('id sequence works after explicit-id insert + resync (next natural insert)', async () => {
    await svc.resyncSequences(['xengine_events']);
    const [next] = await pgDb('xengine_events')
      .insert({ slug: 'fresh', is_active: true })
      .returning('id');
    expect(Number(next.id || next)).toBe(2);
  });
});
