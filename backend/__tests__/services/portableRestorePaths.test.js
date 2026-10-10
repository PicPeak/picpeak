const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const restorePaths = require('../../src/services/portableRestorePaths');

const linux = process.platform === 'linux' ? describe : describe.skip;
linux('actual Linux private restore hierarchy', () => {
  let directory, previous;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-paths-'));
    previous = process.env.STORAGE_PATH;
    process.env.STORAGE_PATH = path.join(directory, 'fresh-storage');
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.STORAGE_PATH; else process.env.STORAGE_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  it('creates fresh storage and one immutable complete marker under concurrent first registrations', async () => {
    const values = await Promise.all(Array.from({ length: 10 }, () => restorePaths.storageIdentity({ create: true })));
    expect(new Set(values.map(value => value.storageId)).size).toBe(1);
    const value = values[0];
    expect(value.root).toBe(process.env.STORAGE_PATH);
    expect(value.identity.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await fs.stat(value.privateRoot)).mode & 0o777).toBe(0o700);
    const marker = path.join(value.privateRoot, 'storage-id');
    expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(marker)).nlink).toBe(1);
    expect(await fs.readFile(marker, 'utf8')).toBe(value.storageId);
    expect(await fs.readdir(value.privateRoot)).toEqual(expect.arrayContaining(['storage-id', 'runtime']));
    expect((await fs.readdir(value.privateRoot)).some(name => name.endsWith('.tmp'))).toBe(false);
    expect((await restorePaths.storageIdentity()).storageId).toBe(value.storageId);
  });
  it('recognizes the F2FS policy without weakening real UID/device/private-path checks', async () => {
    const measure = fs.statfs.bind(fs);
    const observe = jest.spyOn(fs, 'statfs').mockImplementation(async (...args) => ({ ...await measure(...args), type: 0xf2f52010n }));
    try {
      const identity = await restorePaths.storageIdentity({ create: true });
      expect(identity.filesystem).toBe(String(0xf2f52010n));
      expect((await fs.stat(identity.privateRoot)).mode & 0o777).toBe(0o700);
    } finally { observe.mockRestore(); }
  });
  it('refuses symlink/public/hardlinked markers and unknown existing journal contents', async () => {
    const value = await restorePaths.storageIdentity({ create: true });
    const marker = path.join(value.privateRoot, 'storage-id');
    await fs.chmod(marker, 0o644);
    await expect(restorePaths.storageIdentity()).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
    await fs.chmod(marker, 0o600);
    const link = path.join(value.privateRoot, 'copied-marker'); await fs.link(marker, link);
    await expect(restorePaths.storageIdentity()).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
    await fs.unlink(link);
    const attempt = crypto.randomUUID();
    const target = await restorePaths.attemptDirectory(attempt, { create: true });
    await fs.writeFile(path.join(target, 'journal.json'), '{}', { mode: 0o600 });
    await expect(restorePaths.attemptDirectory(attempt, { create: true })).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
    expect(await restorePaths.attemptDirectory(attempt)).toBe(target);
    await fs.unlink(marker); await fs.symlink(path.join(directory, 'foreign-marker'), marker);
    await expect(restorePaths.storageIdentity()).rejects.toBeDefined();
  });
  it('rejects a public private directory and malformed attempt IDs', async () => {
    const value = await restorePaths.storageIdentity({ create: true });
    await fs.chmod(value.privateRoot, 0o755);
    await expect(restorePaths.storageIdentity()).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
    await expect(restorePaths.attemptDirectory('../foreign', { create: true })).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
  });
  it.each([undefined, { bavail: 1n, bsize: 4n }])('unknown statfs never fabricates unlimited capacity and retains typed 507', async measurement => {
    const observe = jest.spyOn(fs, 'statfs').mockResolvedValue(measurement);
    try {
      await expect(restorePaths.storageIdentity({ create: true })).rejects.toMatchObject({ code: 'RESTORE_CAPACITY_UNKNOWN', statusCode: 507 });
    } finally { observe.mockRestore(); }
  });
});

it('unsupported OS never creates an implicit non-native maintenance authority', async () => {
  if (process.platform === 'linux') return;
  await expect(restorePaths.storageIdentity({ create: true })).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
});
