const path = require('path');
const { assertDrillDatabaseName, drillDatabaseName, drillPrefixFor } = require('../../src/utils/drillDatabase');

describe('restore-drill database guard', () => {
  it('builds drill names from the install and the verification id', () => {
    const name = drillDatabaseName(42, 'picpeak');
    expect(name).toMatch(/^picpeak_drill_[0-9a-f]{8}_42$/);
    expect(assertDrillDatabaseName(name, 'picpeak')).toBe(name);
    // Another install on the same server gets another prefix.
    expect(drillDatabaseName(42, 'picpeak_beta')).not.toBe(name);
    expect(drillPrefixFor('picpeak_beta')).not.toBe(drillPrefixFor('picpeak'));
    expect(() => drillDatabaseName('x', 'picpeak')).toThrow();
  });

  it('refuses anything without the drill prefix', () => {
    for (const name of ['picpeak', 'postgres', 'picpeak_drill', 'picpeak_drill_1"; DROP DATABASE picpeak; --', 'x_picpeak_drill_1', '']) {
      expect(() => assertDrillDatabaseName(name, 'picpeak')).toThrow(/restore-drill/);
    }
  });

  it('refuses the live database even when it carries the prefix', () => {
    expect(() => assertDrillDatabaseName('picpeak_drill_7', 'picpeak_drill_7')).toThrow(/live database/);
    expect(assertDrillDatabaseName('picpeak_drill_7', 'picpeak')).toBe('picpeak_drill_7');
  });
});

describe('drill worker target check', () => {
  const { _internal: { assertTarget } } = require('../../src/services/backupVerificationWorker');

  it('aborts when the PostgreSQL connection resolved to the live database', () => {
    const job = { engine: 'pg', liveTarget: { database: 'picpeak' }, drillTarget: { database: 'picpeak_drill_3' } };
    expect(() => assertTarget(job, { client: 'pg', connection: { database: 'picpeak' } })).toThrow();
    expect(() => assertTarget(job, { client: 'pg', connection: { database: 'picpeak_drill_4' } })).toThrow();
    expect(() => assertTarget(job, { client: 'pg', connection: { database: 'picpeak_drill_3' } })).not.toThrow();
  });

  it('aborts when the SQLite connection is the live file or outside the work directory', () => {
    const workDir = '/srv/storage/tmp/backup-verify-3';
    const drill = path.join(workDir, 'drill.sqlite');
    const job = { engine: 'sqlite', workDir, liveTarget: { filename: '/srv/data/live.db' }, drillTarget: { filename: drill } };
    expect(() => assertTarget(job, { client: 'sqlite3', connection: { filename: '/srv/data/live.db' } })).toThrow();
    expect(() => assertTarget({ ...job, drillTarget: { filename: '/srv/data/live.db' } },
      { client: 'sqlite3', connection: { filename: '/srv/data/live.db' } })).toThrow();
    expect(() => assertTarget(job, { client: 'sqlite3', connection: { filename: drill } })).not.toThrow();
  });
});

describe('file selection', () => {
  const { _internal: { selectFiles, overallStatus } } = require('../../src/services/backupVerificationService');
  const entries = [
    { path: 'business-docs/invoice/1.pdf' }, { path: 'business-docs/contract/2.pdf' },
    ...Array.from({ length: 200 }, (_, i) => ({ path: `events/active/E${i}/p.jpg` })),
  ];

  it('always takes every business document', () => {
    const { docs } = selectFiles(entries, { full: false, samplePercent: 5, rotation: 1 });
    expect(docs.map((e) => e.path)).toEqual(['business-docs/invoice/1.pdf', 'business-docs/contract/2.pdf']);
  });

  it('rotates the sample so every file is covered over one cycle', () => {
    const seen = new Set();
    for (let rotation = 0; rotation < 20; rotation += 1) {
      selectFiles(entries, { full: false, samplePercent: 5, rotation }).sample.forEach((e) => seen.add(e.path));
    }
    expect(seen.size).toBe(200);
  });

  it('takes everything on a full run and nothing at 0 %', () => {
    expect(selectFiles(entries, { full: true, samplePercent: 0, rotation: 0 }).sample).toHaveLength(200);
    expect(selectFiles(entries, { full: false, samplePercent: 0, rotation: 0 }).sample).toHaveLength(0);
  });

  it('keeps failed, warning and passed apart', () => {
    expect(overallStatus([{ result: 'passed' }, { result: 'skipped' }])).toBe('passed');
    expect(overallStatus([{ result: 'passed' }, { result: 'warning' }])).toBe('warning');
    expect(overallStatus([{ result: 'warning' }, { result: 'failed' }])).toBe('failed');
  });
});

describe('tiered retention selection', () => {
  const { selectRetainedRuns } = require('../../src/services/backupService');
  // Daily runs, newest first, ids counting up with time.
  const daily = (fromIso, days) => Array.from({ length: days }, (_, i) => {
    const at = new Date(new Date(fromIso).getTime() + i * 24 * 3600 * 1000);
    return { id: i + 1, completed_at: at.toISOString() };
  }).reverse();

  it('keeps only the newest N when no monthly points are asked for, exactly as before', () => {
    const runs = daily('2026-06-01T02:00:00Z', 120);
    expect([...selectRetainedRuns(runs, { keep: 7, now: new Date('2026-09-28T12:00:00Z') })].sort((a, b) => a - b))
      .toEqual(runs.slice(0, 7).map((r) => r.id).sort((a, b) => a - b));
  });

  it('adds the first backup of each of the last M calendar months, this month included', () => {
    const runs = daily('2026-06-01T02:00:00Z', 120); // 1 Jun .. 28 Sep
    const kept = selectRetainedRuns(runs, { keep: 7, monthly: 6, now: new Date('2026-09-28T12:00:00Z') });
    const byId = new Map(runs.map((r) => [r.id, r.completed_at.slice(0, 10)]));
    const keptDates = [...kept].map((id) => byId.get(id)).sort();
    // Sep, Aug, Jul, Jun have backups; May and Apr have none and add nothing.
    expect(keptDates).toEqual(expect.arrayContaining(['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']));
    expect(kept.size).toBe(7 + 4);
  });

  it('crosses a year boundary', () => {
    const runs = daily('2025-11-20T02:00:00Z', 60); // 20 Nov 2025 .. 18 Jan 2026
    const kept = selectRetainedRuns(runs, { keep: 1, monthly: 3, now: new Date('2026-01-18T12:00:00Z') });
    const dates = [...kept].map((id) => runs.find((r) => r.id === id).completed_at.slice(0, 10)).sort();
    expect(dates).toEqual(['2025-11-20', '2025-12-01', '2026-01-01', '2026-01-18']);
  });

  it('decides the month in the instance time zone', () => {
    // 31 Mar 23:30 UTC is already 1 Apr in Zurich.
    const runs = [
      { id: 3, completed_at: '2026-04-02T01:00:00Z' },
      { id: 2, completed_at: '2026-03-31T23:30:00Z' },
      { id: 1, completed_at: '2026-03-15T01:00:00Z' },
    ];
    const now = new Date('2026-04-10T12:00:00Z');
    expect([...selectRetainedRuns(runs, { keep: 0, monthly: 1, now, timeZone: 'UTC' })]).toEqual([3]);
    expect([...selectRetainedRuns(runs, { keep: 0, monthly: 1, now, timeZone: 'Europe/Zurich' })]).toEqual([2]);
  });
});

describe('review round 1 (PR 2461)', () => {
  const { _internal: { fileCheckResult, leftByDeadProcess } } = require('../../src/services/backupVerificationService');

  it('concern 5: matching 100k hashed paths is linear (a Set), not list x results', () => {
    const list = Array.from({ length: 100000 }, (_, i) => ({ path: `events/active/E/${i}.jpg` }));
    const results = list.map((e, i) => ({ path: e.path, ok: i !== 99999, error: i === 99999 ? 'missing' : undefined }));
    const started = Date.now();
    const result = fileCheckResult('files_all', list, results, { what: 'files', none: '-' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ result: 'failed' });
    expect(result.detail).toMatch(/^1 of 100000 files failed: events\/active\/E\/99999\.jpg \(missing\)/);
  });

  it('concern 3: lease ownership by host and pid', () => {
    const row = (owner) => ({ is_running: true, owner });
    expect(leftByDeadProcess(row('h:42'), { hostname: 'h', pid: 42 })).toBe(true);           // this very pid
    expect(leftByDeadProcess(row(`h:${process.ppid}`), { hostname: 'h', pid: 42 })).toBe(false); // alive
    expect(leftByDeadProcess(row('h:2147483646'), { hostname: 'h', pid: 42 })).toBe(true);   // gone
    expect(leftByDeadProcess(row('other:42'), { hostname: 'h', pid: 42 })).toBe(false);      // another host
    expect(leftByDeadProcess({ is_running: false, owner: 'h:42' }, { hostname: 'h', pid: 42 })).toBe(false);
  });
});
