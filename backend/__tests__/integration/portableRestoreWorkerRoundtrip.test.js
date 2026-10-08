'use strict';

const fs = require('fs').promises;
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

// This exercises the actual FD-inheriting, hard-limited worker, not an injected
// coordinator/runner. Linux is the production restore contract.
const linux = process.platform === 'linux' ? describe : describe.skip;
linux('portable restore actual supervised worker roundtrip', () => {
  let db;
  let cleanup;
  let exported;
  let adminId;
  let first;
  let second;
  let importFromPicpeak;
  const marker = async value => db('app_settings').insert({ setting_key: 'owned_atomic_marker',
    setting_value: JSON.stringify(value), setting_type: 'string' }).onConflict('setting_key').merge();
  const readMarker = async () => decodeSettingValue(db,
    (await db('app_settings').where({ setting_key: 'owned_atomic_marker' }).first()).setting_value);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
    const directory = path.join(process.env.STORAGE_PATH, 'business-docs');
    await fs.mkdir(directory, { recursive: true });
    first = path.join(directory, 'a-first.dat');
    second = path.join(directory, 'z-collision.dat');
    await fs.writeFile(first, 'BACKUP-FIRST');
    await fs.writeFile(second, 'BACKUP-SECOND');
    await marker('backup');
    exported = await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false });
    await marker('current');
    await fs.writeFile(first, 'CURRENT-FIRST');
    await fs.unlink(second);
    await fs.mkdir(second);
    await fs.writeFile(path.join(second, 'keep.txt'), 'CURRENT-KEEP');
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/nativeProcessRunner').stop();
    if (exported) await fs.rm(path.dirname(exported.filePath), { recursive: true, force: true });
    if (cleanup) await cleanup();
  });

  test('the original later collision preserves the database and every earlier file', async () => {
    await expect(importFromPicpeak({ picpeakPath: exported.filePath, currentAdminId: adminId }))
      .rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    expect(await readMarker()).toBe('current');
    expect(await fs.readFile(first, 'utf8')).toBe('CURRENT-FIRST');
    expect(await fs.readFile(path.join(second, 'keep.txt'), 'utf8')).toBe('CURRENT-KEEP');
    const state = await db('portable_restore_control').where({ id: 1 }).first();
    expect(state.state).toBe('restart_required');
    expect(JSON.parse(state.result_json).outcome).toBe('rolled_back');
  }, 120000);

  test('the same genuine archive restores normally through a new coordinated offline cohort', async () => {
    await fs.unlink(path.join(second, 'keep.txt'));
    await fs.rmdir(second);
    await fs.writeFile(second, 'CURRENT-SECOND');
    const result = await importFromPicpeak({ picpeakPath: exported.filePath, currentAdminId: adminId });
    expect(result).toMatchObject({ restored: true, outcome: 'committed', restartRequired: true, filesRestored: 2 });
    expect(await readMarker()).toBe('backup');
    expect(await fs.readFile(first, 'utf8')).toBe('BACKUP-FIRST');
    expect(await fs.readFile(second, 'utf8')).toBe('BACKUP-SECOND');
    expect((await db('admin_users').where({ id: adminId }).first()).email).toBe('tester@example.com');
    const control = await db('portable_restore_control').where({ id: 1 }).first();
    const commit = await db('portable_restore_commits').where({ attempt_id: control.attempt_id }).first();
    expect(control.state).toBe('restart_required');
    expect(commit.local_plan_checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(commit.options_digest).toMatch(/^[a-f0-9]{64}$/);
  }, 120000);

  async function withImportPreload(name, source, run) {
    // Fault injection is local to this test's Node launcher. Production has
    // no preload/test-mode escape and retains the exact native hard limits,
    // inherited lifetime FD, pre-exec admission and recovery worker.
    const fixture = path.dirname(process.env.STORAGE_PATH);
    const preload = path.join(fixture, `${name}.cjs`);
    await fs.writeFile(preload, source, { mode: 0o600 });
    const runner = require('../../src/services/nativeProcessRunner');
    const original = runner.run;
    const spy = jest.spyOn(runner, 'run').mockImplementation((command, args, options) =>
      original(command, args.includes('import') ? ['--require', preload, ...args] : args, options));
    try { return await run(); } finally { spy.mockRestore(); await fs.unlink(preload); }
  }

  test('actual SIGKILL after the first file promotion rolls back rows and every file before reporting terminal', async () => {
    await marker('before-crash');
    await fs.writeFile(first, 'PRIOR-FIRST');
    await fs.writeFile(second, 'PRIOR-SECOND');
    const evidence = path.join(path.dirname(process.env.STORAGE_PATH), 'promotion-observed.json');
    const journalModule = require.resolve('../../src/services/portableRestoreJournal');
    const preload = `const fs=require('fs');const {PortableRestoreJournal:J}=require(${JSON.stringify(journalModule)});
      const original=J.prototype.promote;J.prototype.promote=function(source){return original.call(this,source,{onStep:()=>{
        fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({first:fs.readFileSync(${JSON.stringify(first)},'utf8')}),{mode:0o600});
        process.kill(process.pid,'SIGKILL');}})};`;
    await withImportPreload('owned-before-commit-crash', preload, async () => {
      await expect(importFromPicpeak({ picpeakPath: exported.filePath, currentAdminId: adminId }))
        .rejects.toMatchObject({ code: 'RESTORE_ROLLED_BACK' });
    });
    expect(JSON.parse(await fs.readFile(evidence, 'utf8')).first).toBe('BACKUP-FIRST');
    expect(await readMarker()).toBe('before-crash');
    expect(await fs.readFile(first, 'utf8')).toBe('PRIOR-FIRST');
    expect(await fs.readFile(second, 'utf8')).toBe('PRIOR-SECOND');
    const state = await db('portable_restore_control').where({ id: 1 }).first();
    expect(state.state).toBe('restart_required');
    expect(JSON.parse(state.result_json)).toMatchObject({ outcome: 'rolled_back', recoveryAttempted: true });
    expect(await db('portable_restore_commits').where({ attempt_id: state.attempt_id })).toEqual([]);
    await fs.unlink(evidence);
  }, 120000);

  test('actual SIGKILL after acknowledged commit retains and verifies the complete new version', async () => {
    await marker('before-committed-crash');
    await fs.writeFile(first, 'PRIOR-FIRST');
    await fs.writeFile(second, 'PRIOR-SECOND');
    const evidence = path.join(path.dirname(process.env.STORAGE_PATH), 'commit-observed');
    const transactionModule = require.resolve('knex/lib/execution/transaction');
    const preload = `const fs=require('fs');const T=require(${JSON.stringify(transactionModule)});const commit=T.prototype.commit;
      T.prototype.commit=function(connection,value){return commit.call(this,connection,value).then(result=>{
        fs.writeFileSync(${JSON.stringify(evidence)},'acknowledged COMMIT',{mode:0o600});process.kill(process.pid,'SIGKILL');return result;})};`;
    await withImportPreload('owned-after-commit-crash', preload, async () => {
      const result = await importFromPicpeak({ picpeakPath: exported.filePath, currentAdminId: adminId });
      expect(result).toMatchObject({ restored: true, outcome: 'committed', restartRequired: true });
    });
    expect(await fs.readFile(evidence, 'utf8')).toBe('acknowledged COMMIT');
    expect(await readMarker()).toBe('backup');
    expect(await fs.readFile(first, 'utf8')).toBe('BACKUP-FIRST');
    expect(await fs.readFile(second, 'utf8')).toBe('BACKUP-SECOND');
    const state = await db('portable_restore_control').where({ id: 1 }).first();
    expect(state.state).toBe('restart_required');
    expect(JSON.parse(state.result_json)).toMatchObject({ outcome: 'committed', recoveryAttempted: true });
    expect(await db('portable_restore_commits').where({ attempt_id: state.attempt_id }).first()).toBeTruthy();
    await fs.unlink(evidence);
  }, 120000);
});
