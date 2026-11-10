/**
 * Tiered backup retention: the newest backup_retention_count restore points,
 * plus the first one of each of the last backup_retention_monthly_count
 * calendar months. Real local backups; completed_at is moved back in time
 * to place runs in earlier months. Runs on SQLite and PostgreSQL.
 */

const fs = require('fs').promises;
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(240000);

describe('tiered backup retention', () => {
  let db;
  let cleanup;
  let storage;
  let destination;
  let backupService;
  let databaseBackupService;
  let fixtureRoot;

  async function setting(key, value) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup' })
      .onConflict('setting_key').merge();
  }
  const stats = (run) => (typeof run.statistics === 'string' ? JSON.parse(run.statistics) : run.statistics);

  async function backupAt(completedIso) {
    await databaseBackupService.backup({ destinationPath: path.join(fixtureRoot, 'dumps'), inline: true });
    await backupService.runBackup(true);
    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');
    if (completedIso) await db('backup_runs').where({ id: run.id }).update({ completed_at: completedIso, started_at: completedIso });
    return run;
  }
  const remaining = async () => (await db('backup_runs').orderBy('id').select('id')).map((r) => r.id);

  beforeAll(async () => {
    ({ db, cleanup, tmpDir: fixtureRoot } = await bootCrmDb());
    storage = process.env.STORAGE_PATH;
    destination = path.join(fixtureRoot, 'retention-backups');
    backupService = require('../../src/services/backupService');
    ({ databaseBackupService } = require('../../src/services/databaseBackup'));
    await fs.mkdir(path.join(storage, 'business-docs'), { recursive: true });
    await fs.writeFile(path.join(storage, 'business-docs', 'a.pdf'), 'doc');
    await db('business_profile').where({ id: 1 }).update({ timezone: 'Europe/Zurich' }).catch(() => {});
  });
  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('backup_verifications').del();
    await db('backup_runs').del();
    await fs.rm(destination, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      backup_enabled: false, backup_destination_type: 'local', backup_destination_path: destination,
      backup_include_database: true, backup_database_inline_dump: false,
      backup_email_on_success: false, backup_email_on_failure: false,
      backup_retention_count: 1, backup_retention_monthly_count: 0,
    })) await setting(key, value);
  });

  // Months relative to today, so the "last N months" window is real.
  const monthsAgo = (n, day) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, day, 10, 0, 0)).toISOString();
  };

  it('with monthly = 0 keeps only the newest restore points, as before', async () => {
    const a = await backupAt(monthsAgo(2, 3));
    const b = await backupAt(monthsAgo(1, 3));
    const c = await backupAt(null);
    expect(await remaining()).toEqual([c.id]);
    for (const gone of [a, b]) await expect(fs.stat(stats(gone).snapshot_path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the first backup of each of the last M months on top, skipping months without backups', async () => {
    await setting('backup_retention_monthly_count', 3);
    const tooOld = await backupAt(monthsAgo(4, 2));       // outside the window
    const twoAgoFirst = await backupAt(monthsAgo(2, 2));  // first of its month: kept
    const twoAgoLater = await backupAt(monthsAgo(2, 20)); // not the first: pruned
    // one month ago: no backup at all
    const current = await backupAt(null);                 // this month, newest
    expect(await remaining()).toEqual([twoAgoFirst.id, current.id]);
    expect(tooOld.id).toBeLessThan(twoAgoLater.id);
  });

  it('leaves a restore point that is under test, and removes the test rows of the ones it prunes', async () => {
    // A test can only be running with the feature on.
    await db('feature_flags').where({ key: 'backupRestoreTest' }).update({ value: true });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    // ...but no automatic tests of these backups, which would sweep the
    // hand-made running row as a leftover.
    await setting('backup_verify_enabled', false);
    await setting('backup_retention_count', 2);
    const underTest = await backupAt(null);
    const tested = await backupAt(null);
    await setting('backup_retention_count', 1);
    const row = (fields) => db('backup_verifications').insert({
      level: 'deep', checks: '[]', triggered_by: 'schedule', started_at: new Date().toISOString(), ...fields,
    });
    await row({ backup_run_id: underTest.id, status: 'running' });
    await row({ backup_run_id: tested.id, status: 'passed', completed_at: new Date().toISOString() });
    // keep = 1: the new run stays, `tested` is pruned with its row, `underTest` waits.
    const latest = await backupAt(null);
    expect(await remaining()).toEqual([underTest.id, latest.id]);
    expect(await db('backup_verifications').where({ backup_run_id: tested.id })).toEqual([]);
    expect(await db('backup_verifications').where({ backup_run_id: underTest.id })).toHaveLength(1);
  });
});
