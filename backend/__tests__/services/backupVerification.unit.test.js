const path = require('path');
const { assertDrillDatabaseName, drillDatabaseName } = require('../../src/utils/drillDatabase');

describe('restore-drill database guard', () => {
  it('builds drill names from the verification id only', () => {
    expect(drillDatabaseName(42)).toBe('picpeak_drill_42');
    expect(() => drillDatabaseName('x')).toThrow();
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
