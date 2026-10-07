const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  assertCompleteFileRestore, assertLocalBackupRoot, parseS3Location, resolveBackupPointLocation,
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
  it('refuses local type tokens, relative paths and control characters as snapshot roots', async () => {
    for (const value of ['local', 'relative/path', root + '\n']) {
      await expect(assertLocalBackupRoot(value, config)).rejects.toThrow(/Invalid local/);
    }
  });
});
