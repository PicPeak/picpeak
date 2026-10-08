const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  assertCompleteFileRestore, assertLocalBackupRoot, parseS3Location, resolveBackupPointLocation,
  standaloneSnapshotOfRun, removeLocalSnapshot, removeS3Snapshot,
} = require('../../src/utils/backupRestorePoint');

describe('selected standalone restore-point boundary', () => {
  let root;
  let outside;
  let config;
  const point = (backupPath, destination = 'local') => ({
    backup: { type: 'full', parent_backup_id: null, path: backupPath },
    metadata: { restore_point: 'standalone-v1', destination_type: destination },
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-point-root-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-point-outside-'));
    config = { backup_destination_path: root };
  });
  afterEach(async () => {
    delete process.env.RESTORE_ALLOWED_ROOTS;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it.each(['full', 'files'])('refuses an ambiguous legacy %s restore even with force/dryRun', restoreType => {
    const legacy = { backup: { type: 'incremental' }, metadata: { destination_type: 'local' } };
    expect(() => assertCompleteFileRestore(legacy, { restoreType, force: true, dryRun: true }))
      .toThrow(/cannot prove a complete file set/);
    legacy.metadata.backup_settings = { backup_incremental: false };
    expect(() => assertCompleteFileRestore(legacy, { restoreType })).toThrow(/cannot prove/);
  });
  it.each(['database', 'selective'])('preserves legacy %s recovery', restoreType => {
    expect(() => assertCompleteFileRestore({
      backup: { type: 'incremental' }, metadata: { destination_type: 's3' },
    }, { restoreType })).not.toThrow();
  });
  it.each([true, 'true', 'TRUE', ' true ', 1, '1', 'yes'])('handles legacy incremental setting %j like the writer', value => {
    expect(() => assertCompleteFileRestore({
      backup: { type: 'full' },
      metadata: { destination_type: 's3', backup_settings: { backup_incremental: value } },
    }, { restoreType: 'full', force: true })).toThrow(/cannot prove/);
  });
  it('still restores a legacy local full catalogue taken with the incremental setting on', () => {
    const legacy = {
      backup: { type: 'full' },
      metadata: { destination_type: 'local', backup_settings: { backup_incremental: true } },
    };
    expect(() => assertCompleteFileRestore(legacy, { restoreType: 'full', force: true })).not.toThrow();
    legacy.backup.type = 'incremental';
    expect(() => assertCompleteFileRestore(legacy, { restoreType: 'full', force: true }))
      .toThrow(/legacy incremental backup only lists the files that changed/);
  });
  it('preserves legacy full-copy and rsync catalogues', () => {
    expect(() => assertCompleteFileRestore({ backup: { type: 'full' } }, { restoreType: 'files' })).not.toThrow();
    expect(() => assertCompleteFileRestore({
      backup: { type: 'incremental' }, metadata: { destination_type: 'rsync' },
    }, { restoreType: 'full' })).not.toThrow();
  });
  it.each([
    { restore_point: 'future-v2', destination_type: 'local' },
    { restore_point: 'standalone-v1', destination_type: 'rsync' },
  ])('refuses unsupported or contradictory new metadata', metadata => {
    expect(() => assertCompleteFileRestore({ ...point(root), metadata }, { restoreType: 'database' })).toThrow();
    expect(() => assertCompleteFileRestore({
      ...point(root), backup: { type: 'incremental', path: root },
    }, { restoreType: 'files' })).toThrow(/Invalid standalone/);
    expect(() => assertCompleteFileRestore({
      ...point(root), backup: { type: 'full', parent_backup_id: 'ancestor', path: root },
    }, { restoreType: 'files' })).toThrow(/Invalid standalone/);
  });

  it('resolves the selected local snapshot, not the current mirror', async () => {
    const snapshot = path.join(root, 'backup-selected');
    await fs.mkdir(snapshot);
    expect(await resolveBackupPointLocation(point(snapshot), {
      source: 'local', manifestPath: path.join(root, 'custom-manifests', 'm.json'),
    }, config)).toBe(await fs.realpath(snapshot));
  });
  it('allows a rescued mount without rewriting its manifest', async () => {
    const relocated = path.join(root, 'backup-selected');
    await fs.mkdir(path.join(relocated, 'manifests'), { recursive: true });
    expect(await resolveBackupPointLocation(point('/old-mount/backup-selected'), {
      source: 'local', manifestPath: path.join(relocated, 'manifests', 'm.yaml'),
    }, config)).toBe(await fs.realpath(relocated));
  });
  it('allows renamed nested points and downloaded archive aliases inside configured roots', async () => {
    const relocated = path.join(root, 'renamed-rescued-point');
    await fs.mkdir(path.join(relocated, 'manifests'), { recursive: true });
    const manifest = point('/unavailable-original/backup-original');
    manifest.metadata.restore_point_manifest_layout = 'nested';
    for (const selected of ['manifests/m.yaml', 'manifest.json']) {
      expect(await resolveBackupPointLocation(manifest, {
        source: 'local', manifestPath: path.join(relocated, selected),
      }, config)).toBe(await fs.realpath(relocated));
    }
  });
  it('refuses an unconfigured manifest root instead of trusting it', async () => {
    await expect(resolveBackupPointLocation(point(outside), {
      source: 'local', manifestPath: path.join(root, 'm.json'),
    }, config)).rejects.toThrow(/outside configured/);
    await expect(assertLocalBackupRoot(root + '-sibling', config)).rejects.toThrow(/outside configured/);
  });
  it('accepts a server-supplied extra root, and only as a root', async () => {
    const snapshot = path.join(outside, 'backup-selected');
    await fs.mkdir(path.join(snapshot, 'manifests'), { recursive: true });
    const options = { source: 'local', manifestPath: path.join(snapshot, 'manifests', 'm.json') };
    const manifest = point(snapshot);
    manifest.metadata.restore_point_manifest_layout = 'nested';
    await expect(resolveBackupPointLocation(manifest, options, config)).rejects.toThrow(/outside configured/);
    expect(await resolveBackupPointLocation(manifest, { ...options, allowedRoots: [outside] }, config))
      .toBe(await fs.realpath(snapshot));
    await expect(resolveBackupPointLocation(manifest, { ...options, allowedRoots: outside }, config))
      .rejects.toThrow(/outside configured/);
  });
  it('refuses symlink escapes and non-directories', async () => {
    const link = path.join(root, 'backup-link');
    await fs.symlink(outside, link, 'dir');
    await expect(resolveBackupPointLocation(point(link), { source: 'local' }, config))
      .rejects.toThrow(/symbolic link/);
    const file = path.join(root, 'file');
    await fs.writeFile(file, 'not a directory');
    await expect(assertLocalBackupRoot(file, config)).rejects.toThrow(/not a directory/);
  });
  it('preserves explicit configured paths and additional operator roots', async () => {
    process.env.RESTORE_ALLOWED_ROOTS = outside;
    expect(await resolveBackupPointLocation(point(outside), { source: outside }, config))
      .toBe(await fs.realpath(outside));
    expect(await resolveBackupPointLocation({ backup: { type: 'full' } }, { source: 'local' }, config))
      .toBe(await fs.realpath(root));
    const relative = path.relative(process.cwd(), root);
    expect(await resolveBackupPointLocation({ backup: { type: 'incremental' } }, {
      source: 'local', restoreType: 'database',
    }, { backup_destination_path: relative })).toBe(await fs.realpath(root));
    expect(await resolveBackupPointLocation(point(root), { source: relative }, config))
      .toBe(await fs.realpath(root));
  });
  it('derives S3 type-token location from the selected manifest, not current settings or metadata', async () => {
    expect(await resolveBackupPointLocation(point('s3://old/other', 's3'), {
      source: 's3', manifestPath: 's3://rescued/prefix/backup-selected/manifests/m.yaml',
    }, { backup_s3_bucket: 'current' })).toBe('s3://rescued/prefix/backup-selected');
    expect(await resolveBackupPointLocation(point('s3://old/other', 's3'), {
      source: 's3://explicit/point/',
    }, {})).toBe('s3://explicit/point');
  });
  it.each(['s3://bucket/a/../point', 's3://bucket/a/./point', 's3://bucket/', 's3://bucket/a\npoint'])(
    'refuses ambiguous S3 location %j', value => {
      expect(() => parseS3Location(value)).toThrow(/Invalid S3/);
    });
  it('refuses a selected S3 manifest outside a per-point manifests directory', async () => {
    await expect(resolveBackupPointLocation(point('s3://bucket/a', 's3'), {
      source: 's3', manifestPath: 's3://bucket/other/m.json',
    }, {})).rejects.toThrow(/does not identify/);
    await expect(resolveBackupPointLocation(point('s3://bucket/a', 's3'), {
      source: 's3', manifestPath: 's3://bucket/manifests/m.json',
    }, {})).rejects.toThrow(/Invalid S3/);
  });
  describe('snapshot removal scope', () => {
    const uuid = 'backup-00000000-0000-4000-8000-000000000001';
    it('only names a UUID snapshot directly inside the configured destination', () => {
      const run = manifestPath => ({ manifest_path: manifestPath });
      expect(standaloneSnapshotOfRun(config, run(path.join(root, uuid, 'manifests', 'm.json'))))
        .toMatchObject({ type: 'local', root: path.join(root, uuid), manifestFile: null });
      for (const manifestPath of [
        path.join(root, 'manifests', 'm.json'),
        path.join(root, 'backup-1756692000000', 'manifests', 'm.json'),
        path.join(root, 'nested', uuid, 'manifests', 'm.json'),
        path.join(outside, uuid, 'manifests', 'm.json'),
        path.join(root, uuid, 'other', 'm.json'),
        '',
      ]) expect(standaloneSnapshotOfRun(config, run(manifestPath))).toBeNull();
    });
    it('takes an external manifest\'s snapshot from the run record, still scoped to the destination', () => {
      const external = { ...config, backup_manifest_path: path.join(outside, 'manifests') };
      const manifestPath = path.join(outside, 'manifests', 'm.json');
      expect(standaloneSnapshotOfRun(external, {
        manifest_path: manifestPath, statistics: JSON.stringify({ snapshot_path: path.join(root, uuid) }),
      })).toMatchObject({ root: path.join(root, uuid), manifestFile: manifestPath });
      for (const snapshotPath of [path.join(outside, uuid), root, path.join(root, 'events'), undefined]) {
        expect(standaloneSnapshotOfRun(external, {
          manifest_path: manifestPath, statistics: { snapshot_path: snapshotPath },
        })).toBeNull();
      }
    });
    it('only names an S3 UUID prefix in the configured bucket and base prefix', () => {
      const s3 = { backup_s3_bucket: 'bucket', backup_s3_prefix: 'base' };
      expect(standaloneSnapshotOfRun(s3, { manifest_path: `s3://bucket/base/2026/10/07/${uuid}/manifests/m.json` }))
        .toEqual({ type: 's3', bucket: 'bucket', prefix: `base/2026/10/07/${uuid}` });
      for (const manifestPath of [
        `s3://other/base/2026/10/07/${uuid}/manifests/m.json`,
        `s3://bucket/elsewhere/${uuid}/manifests/m.json`,
        `s3://bucket/base/../${uuid}/manifests/m.json`,
        's3://bucket/base/2026/10/07/backup-1756692000000/manifests/m.json',
        `s3://bucket/base/${uuid}/m.json`,
      ]) expect(standaloneSnapshotOfRun(s3, { manifest_path: manifestPath })).toBeNull();
    });
    it('refuses to remove anything that is not a snapshot of the destination', async () => {
      await fs.mkdir(path.join(root, 'events'));
      await expect(removeLocalSnapshot(root, path.join(root, 'events'))).rejects.toThrow(/not a standalone/);
      await expect(removeLocalSnapshot(root, root)).rejects.toThrow(/not a standalone/);
      await expect(removeLocalSnapshot(root, path.join(outside, uuid))).rejects.toThrow(/not a standalone/);
      await fs.mkdir(path.join(outside, 'target'));
      await fs.symlink(path.join(outside, 'target'), path.join(root, uuid), 'dir');
      await expect(removeLocalSnapshot(root, path.join(root, uuid))).rejects.toThrow(/escapes/);
      expect(await fs.stat(path.join(outside, 'target'))).toBeTruthy();
      expect(await removeLocalSnapshot(root, path.join(root, uuid.replace(/1$/, '2')))).toBe(false);
      const adapter = { list: jest.fn(), deleteMany: jest.fn() };
      await expect(removeS3Snapshot(adapter, 'base/backup-1756692000000')).rejects.toThrow(/not a standalone/);
      await expect(removeS3Snapshot(adapter, 'base')).rejects.toThrow(/not a standalone/);
      expect(adapter.list).not.toHaveBeenCalled();
    });
    it('removes every page of an S3 snapshot and reports objects that would not go', async () => {
      const prefix = `base/2026/10/07/${uuid}`;
      const adapter = {
        list: jest.fn()
          .mockResolvedValueOnce({ Contents: [{ Key: `${prefix}/a.jpg` }], IsTruncated: true, NextContinuationToken: 'next' })
          .mockResolvedValueOnce({ Contents: [{ Key: `${prefix}/manifests/m.json` }, { Key: 'base/stray' }], IsTruncated: false }),
        deleteMany: jest.fn().mockResolvedValue({ Deleted: [], Errors: [] }),
      };
      expect(await removeS3Snapshot(adapter, prefix)).toBe(2);
      expect(adapter.list).toHaveBeenNthCalledWith(2, `${prefix}/`, { maxKeys: 1000, continuationToken: 'next' });
      expect(adapter.deleteMany).toHaveBeenCalledWith([`${prefix}/a.jpg`, `${prefix}/manifests/m.json`]);
      adapter.list.mockResolvedValueOnce({ Contents: [{ Key: `${prefix}/a.jpg` }], IsTruncated: false });
      adapter.deleteMany.mockResolvedValueOnce({ Deleted: [], Errors: [{ Key: `${prefix}/a.jpg` }] });
      await expect(removeS3Snapshot(adapter, prefix)).rejects.toThrow(/1 of 1 objects/);
    });
  });
  it('refuses local type tokens, relative paths and control characters as snapshot roots', async () => {
    for (const value of ['local', 'relative/path', root + '\n']) {
      await expect(assertLocalBackupRoot(value, config)).rejects.toThrow(/Invalid local/);
    }
  });
});
