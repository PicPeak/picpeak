'use strict';

/**
 * PostgreSQL `date` columns survive a .picpeak export → import in any zone.
 *
 * node-pg reads a `date` as a Date at LOCAL midnight. The export used to
 * JSON.stringify that as a UTC instant, which is the day before east of UTC
 * ("2024-08-10T22:00:00.000Z" for 2024-08-11 in Berlin), and Postgres kept
 * that earlier day on import: one day lost per roundtrip. The export now
 * writes the calendar day, and the import repairs archives written before.
 *
 * Ungated: the repair of legacy instants, for zones on both sides of UTC.
 * Gated on PICPEAK_PG_TEST_URL (same contract as picpeakRestorePg.test.js):
 * pg → pg and sqlite → pg through the real export writer and the import's
 * row preparation, under Europe/Berlin and America/New_York, e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:pw@127.0.0.1:7102/picpeak_date_test" \
 *     npx jest __tests__/integration/picpeakDateOnly.test.js
 */
const path = require('path');
const { execFileSync } = require('child_process');

// A jest worker cannot change its own time zone (process.env there is a
// copy), so anything zone-dependent runs in a child node with TZ set.
const runInZone = (zone, args, env = {}) => execFileSync(process.execPath, args, {
  env: { ...process.env, ...env, TZ: zone },
  encoding: 'utf8',
});

// What the export used to write for these pg `date` values read in `zone`.
const legacyInstants = (zone, days) => JSON.parse(runInZone(zone, [
  '-e',
  `process.stdout.write(JSON.stringify(${JSON.stringify(days)}.map(([y, m, d]) => new Date(y, m - 1, d).toISOString())))`,
]));

describe('repairDateOnly (archives written before the fix)', () => {
  let repairDateOnly;
  let repairDateOnlyColumns;
  let prepareEngineRows;

  beforeAll(() => {
    jest.resetModules();
    ({ repairDateOnly, repairDateOnlyColumns, prepareEngineRows } = require('../../src/services/picpeakImportService'));
  });

  const zones = [
    'UTC', 'Europe/Berlin', 'Europe/Zurich', 'Europe/London', 'Asia/Kolkata', 'Asia/Kathmandu',
    'Asia/Tokyo', 'Australia/Sydney', 'America/New_York', 'America/St_Johns', 'America/Los_Angeles',
    'Pacific/Honolulu', 'Pacific/Fiji',
  ];
  // Winter and summer, so both sides of DST are covered.
  const days = [[2024, 1, 15], [2024, 8, 11], [2024, 12, 31], [2025, 3, 30]];

  for (const zone of zones) {
    it(`recovers the source day from ${zone}`, () => {
      const legacy = legacyInstants(zone, days);
      for (const [i, [y, m, d]] of days.entries()) {
        const expected = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        expect(repairDateOnly(legacy[i])).toBe(expected);
      }
    });
  }

  // Local midnight at UTC+13 or later lands 11h or less before the next UTC
  // midnight, the same instant as UTC-11 to UTC-13 for the day before; one
  // archive cannot tell them apart. Pinned so the limit stays a choice.
  it('cannot recover UTC+13 sources (Tonga, New Zealand summer)', () => {
    const [legacy] = legacyInstants('Pacific/Tongatapu', [[2024, 8, 11]]);
    expect(legacy).toBe('2024-08-10T11:00:00.000Z');
    expect(repairDateOnly(legacy)).toBe('2024-08-10');
  });

  it('shows the shift it repairs', () => {
    expect(legacyInstants('Europe/Berlin', [[2024, 8, 11]])).toEqual(['2024-08-10T22:00:00.000Z']);
    expect(legacyInstants('America/New_York', [[2024, 8, 11]])).toEqual(['2024-08-11T04:00:00.000Z']);
  });

  it('passes plain dates, nulls and non-strings through unchanged', () => {
    expect(repairDateOnly('2024-08-11')).toBe('2024-08-11');
    expect(repairDateOnly(null)).toBeNull();
    expect(repairDateOnly(undefined)).toBeUndefined();
    expect(repairDateOnly('')).toBe('');
    expect(repairDateOnly(1723400000000)).toBe(1723400000000);
  });

  it('leaves an instant that is not a shifted midnight for Postgres to cast', () => {
    expect(repairDateOnly('2024-08-11T13:12:44.123Z')).toBe('2024-08-11T13:12:44.123Z');
    expect(repairDateOnly('2024-08-11T13:07:00.000Z')).toBe('2024-08-11T13:07:00.000Z');
  });

  it('only rewrites the named columns and keeps untouched rows as they were', () => {
    const untouched = { id: 2, d: '2024-08-11', ts: '2024-08-10T22:00:00.000Z' };
    const rows = repairDateOnlyColumns(
      [{ id: 1, d: '2024-08-10T22:00:00.000Z', ts: '2024-08-10T22:00:00.000Z' }, untouched],
      ['d']
    );
    expect(rows[0]).toEqual({ id: 1, d: '2024-08-11', ts: '2024-08-10T22:00:00.000Z' });
    expect(rows[1]).toBe(untouched);
  });

  it('on a SQLite source, repairs epoch numbers only and leaves strings as SQLite showed them', () => {
    const berlinMidnight = Date.UTC(2024, 7, 10, 22); // 2024-08-11 00:00 in Berlin
    const newYorkMidnight = Date.UTC(2024, 7, 11, 4); // 2024-08-11 00:00 in New York
    const rows = repairDateOnlyColumns([
      { id: 1, d: berlinMidnight },
      { id: 2, d: String(newYorkMidnight) },
      { id: 3, d: '2024-08-11T13:00:00.000Z' },
      { id: 4, d: '2024-08-10T22:00:00.000Z' },
      { id: 5, d: '2024-08-11' },
      { id: 6, d: null },
    ], ['d'], { crossEngine: true });
    expect(rows.map((r) => r.d)).toEqual([
      '2024-08-11', '2024-08-11', '2024-08-11T13:00:00.000Z', '2024-08-10T22:00:00.000Z', '2024-08-11', null,
    ]);
  });

  it('prepareEngineRows repairs before the cross-engine coercion', () => {
    const types = { timestamps: ['d', 'ts'], booleans: ['b'] };
    const [row] = prepareEngineRows([{ d: Date.UTC(2024, 7, 10, 22), ts: Date.UTC(2024, 7, 10, 22), b: 1 }],
      { crossEngine: true, types, dateOnlyColumns: ['d'] });
    expect(row).toEqual({ d: '2024-08-11', ts: '2024-08-10T22:00:00.000Z', b: true });
  });
});

// ── Real-Postgres roundtrips (gated) ─────────────────────────────────────────
const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;
const PROBE = path.join(__dirname, 'helpers', 'picpeakDateOnlyProbe.js');
const DAYS = ['2024-08-11', '2024-01-15', '2024-12-31'];

// Each zone runs helpers/picpeakDateOnlyProbe.js: the real export writer, the
// import's row preparation for a pg target, and real pg / sqlite tables.
maybe('pg date columns roundtrip through a .picpeak archive', () => {
  for (const zone of ['Europe/Berlin', 'America/New_York']) {
    describe(`with TZ=${zone}`, () => {
      let out;
      beforeAll(() => {
        out = JSON.parse(runInZone(zone, [PROBE], { PICPEAK_PG_TEST_URL: PG_URL }).trim().split('\n').pop());
      });

      it('pg → pg keeps every day over two roundtrips, and the archive holds plain dates', () => {
        expect(out.zone).toBe(zone);
        for (const round of out.pgToPg) {
          expect(round.archived).toEqual([...DAYS, null]);
          expect(round.stored).toEqual([...DAYS, null]);
          // Timestamps still travel as instants.
          expect(round.archivedTs).toBe('2024-08-11T10:00:00.000Z');
        }
        expect(out.pgToPg).toHaveLength(2);
      });

      it('sqlite → pg keeps the day SQLite showed: date strings, local-midnight Dates, client instants', () => {
        // The app's Dates reach the archive as epoch ms of local midnight.
        expect(out.sqliteToPg.archived.slice(DAYS.length, 2 * DAYS.length).every((v) => typeof v === 'number')).toBe(true);
        // An instant an API client stored is a string, not a shifted midnight,
        // so it keeps its first ten characters rather than the nearest UTC day.
        const clientDays = ['2024-08-11', '2024-08-10'];
        expect(out.sqliteToPg.stored).toEqual([...DAYS, ...DAYS, ...clientDays]);
        expect(out.sqliteToPg.reexported).toEqual([...DAYS, ...DAYS, ...clientDays]);
      });

      it('a legacy pg archive with shifted instants restores the source day', () => {
        // The archive really is shifted: east of UTC it names the day before.
        if (zone === 'Europe/Berlin') expect(out.legacy.archived[0]).toBe('2024-08-10T22:00:00.000Z');
        if (zone === 'America/New_York') expect(out.legacy.archived[0]).toBe('2024-08-11T04:00:00.000Z');
        expect(out.legacy.stored).toEqual(DAYS);
      });
    });
  }
});
