'use strict';

// Cross-platform checks for the parts of coordinated restore that must hold on
// every host: the capability probe, the fence marker, cleanup, the drain
// deadline, limits and the lock-free journal promotion. Linux-only branches
// run here with the platform and filesystem answers supplied by the test.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const EXT4 = { type: 0xef53n, bsize: 4096n, bavail: 1024n * 1024n * 1024n, ffree: 1024n * 1024n };
const asPlatform = value => Object.defineProperty(process, 'platform', { value, configurable: true });
const realPlatform = process.platform;
let directory, previousStorage;

beforeEach(async () => {
  directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-degrade-')));
  previousStorage = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = path.join(directory, 'storage');
  await fsp.mkdir(process.env.STORAGE_PATH);
});
afterEach(async () => {
  asPlatform(realPlatform);
  jest.restoreAllMocks();
  jest.resetModules();
  if (previousStorage === undefined) delete process.env.STORAGE_PATH; else process.env.STORAGE_PATH = previousStorage;
  for (const name of ['PICPEAK_IMPORT_MAX_ROW_BYTES']) delete process.env[name];
  await fsp.rm(directory, { recursive: true, force: true });
});

describe('restore capability probe', () => {
  function load({ addon = true, guard = true } = {}) {
    jest.doMock('../../src/services/mediaCapabilities', () => ({
      loadAddon: () => { if (!addon) throw new Error('addon is not built'); return {}; },
      probe: async () => ({ guard, leases: true }),
    }));
    return require('../../src/services/portableRestoreCapability');
  }

  it('never throws and names the reason on a host that is not Linux', async () => {
    asPlatform('darwin');
    await expect(load().probe()).resolves.toEqual({ available: false, reason: 'RESTORE_UNSUPPORTED_PLATFORM', message: expect.stringContaining('Linux') });
  });

  it.each([
    ['a missing lease addon', { addon: false }, EXT4, 'RESTORE_LEASE_UNAVAILABLE'],
    ['a process guard that cannot supervise', { guard: false }, EXT4, 'RESTORE_GUARD_UNAVAILABLE'],
    ['storage on NFS', {}, { ...EXT4, type: 0x6969n }, 'RESTORE_STORAGE_UNSUPPORTED'],
    ['storage on CIFS', {}, { ...EXT4, type: 0xff534d42n }, 'RESTORE_STORAGE_UNSUPPORTED'],
  ])('is unavailable, not fatal, with %s', async (_label, options, stats, reason) => {
    asPlatform('linux');
    jest.spyOn(fsp, 'statfs').mockResolvedValue(stats);
    const result = await load(options).probe();
    expect(result).toMatchObject({ available: false, reason });
    expect(result.message).toEqual(expect.any(String));
  });

  it('is available on Linux with the addon, the guard and local storage, and probes the static part once', async () => {
    asPlatform('linux');
    const statfs = jest.spyOn(fsp, 'statfs').mockResolvedValue(EXT4);
    const capability = load();
    await expect(capability.probe()).resolves.toEqual({ available: true, reason: null, message: null });
    await capability.probe();
    expect(statfs).toHaveBeenCalledTimes(1);
  });

  it('survives a storage root that does not exist yet or cannot be measured', async () => {
    asPlatform('linux');
    process.env.STORAGE_PATH = path.join(directory, 'not', 'created', 'yet');
    const statfs = jest.spyOn(fsp, 'statfs').mockImplementation(async target => {
      if (target !== directory) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return EXT4;
    });
    await expect(load().probe()).resolves.toMatchObject({ available: true });
    statfs.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    jest.resetModules();
    await expect(load().probe()).resolves.toMatchObject({ available: false, reason: 'RESTORE_STORAGE_UNSUPPORTED' });
  });

  it('keeps the list of local filesystems in one module', async () => {
    const services = path.resolve(__dirname, '../../src/services');
    const holders = (await fsp.readdir(services)).filter(name => name.endsWith('.js')
      && /0xef53n/.test(fs.readFileSync(path.join(services, name), 'utf8')));
    expect(holders).toEqual(['portableRestoreCapability.js']);
    const { isLocalFilesystem } = require('../../src/services/portableRestoreCapability');
    expect([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n, 0x2fc12fc1n, 0xf2f52010n].every(isLocalFilesystem)).toBe(true);
    expect([0x6969n, 0xff534d42n, 0x65735546n, undefined, 'x'].some(isLocalFilesystem)).toBe(false);
    // statfs may report a 32-bit type sign-extended.
    expect(isLocalFilesystem(-1859950530n)).toBe(true);
  });
});

describe('fence marker and workspace cleanup', () => {
  const paths = () => require('../../src/services/portableRestorePaths');
  const maintenance = () => path.join(process.env.STORAGE_PATH, '.picpeak-maintenance');
  const attempt = async (id, names) => {
    const base = path.join(maintenance(), id);
    await fsp.mkdir(base, { recursive: true });
    for (const name of names) {
      if (name.includes('.')) await fsp.writeFile(path.join(base, name), 'x');
      else { await fsp.mkdir(path.join(base, name), { recursive: true }); await fsp.writeFile(path.join(base, name, 'file'), 'x'); }
    }
    return base;
  };

  it('reads nothing and creates nothing on an install that never restored', async () => {
    expect(await paths().readFence()).toBeNull();
    expect(await fsp.readdir(process.env.STORAGE_PATH)).toEqual([]);
    expect(await paths().reapLeftovers()).toBe(0);
    expect(await fsp.readdir(process.env.STORAGE_PATH)).toEqual([]);
  });

  it('round-trips the marker atomically and ignores a damaged one', async () => {
    await fsp.mkdir(maintenance(), { mode: 0o700 });
    await paths().writeFence({ fenced: true, generation: 3 });
    expect(await paths().readFence()).toMatchObject({ fenced: true, generation: 3, since: expect.any(Number) });
    await paths().writeFence({ fenced: false, generation: 4 });
    expect(await paths().readFence()).toMatchObject({ fenced: false, generation: 4 });
    expect((await fsp.readdir(maintenance())).filter(name => name.endsWith('.next'))).toEqual([]);
    await fsp.writeFile(paths().fencePath(), '{"fenced":"yes"}');
    expect(await paths().readFence()).toBeNull();
  });

  it('removes the whole attempt after a rollback, and all but the undo copies after a commit', async () => {
    const rolledBack = crypto.randomUUID();
    const committed = crypto.randomUUID();
    const everything = ['workspace', 'request.picpeak', 'new', 'undo', 'plan.ndjson', 'state.json', 'worker.lease'];
    const first = await attempt(rolledBack, everything);
    const second = await attempt(committed, everything);
    await paths().cleanAttempt(rolledBack, { committed: false });
    await expect(fsp.stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    await paths().cleanAttempt(committed, { committed: true });
    expect((await fsp.readdir(second)).sort()).toEqual(['plan.ndjson', 'state.json', 'undo', 'worker.lease']);
    await paths().cleanAttempt('../escape', { committed: false });
  });

  it('reaps interrupted uploads and old attempts at boot, keeps a live attempt and a fresh undo set', async () => {
    const current = crypto.randomUUID();
    const old = crypto.randomUUID();
    const live = await attempt(current, ['workspace', 'request.picpeak', 'new', 'undo', 'state.json']);
    const stale = await attempt(old, ['workspace', 'undo']);
    await fsp.mkdir(path.join(maintenance(), 'uploads', crypto.randomUUID()), { recursive: true });
    await fsp.writeFile(path.join(maintenance(), 'storage-id'), 'kept');
    // While the control row still names a running attempt nothing of it goes.
    await paths().reapLeftovers({ current, currentTerminal: false });
    expect((await fsp.readdir(live)).sort()).toEqual(['new', 'request.picpeak', 'state.json', 'undo', 'workspace']);
    await expect(fsp.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsp.readdir(path.join(maintenance(), 'uploads'))).toHaveLength(1);
    // Terminal: the bulky parts go at once, the undo copies after the retention.
    await paths().reapLeftovers({ current, currentTerminal: true });
    expect((await fsp.readdir(live)).sort()).toEqual(['state.json', 'undo']);
    expect(await fsp.readdir(path.join(maintenance(), 'uploads'))).toEqual([]);
    await paths().reapLeftovers({ current, currentTerminal: true, now: Date.now() + paths().UNDO_RETENTION_MS + 1000 });
    await expect(fsp.stat(live)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsp.readFile(path.join(maintenance(), 'storage-id'), 'utf8')).toBe('kept');
  });

  it('registers with the host id the media layer persists, not one derived again', async () => {
    asPlatform('linux');
    const boot = crypto.randomUUID();
    const host = crypto.createHash('sha256').update('persisted').digest('hex');
    jest.doMock('../../src/services/linuxProcessLease', () => ({ hostIdentity: async () => ({ host, source: 'generated' }) }));
    const readFile = fsp.readFile.bind(fsp);
    const read = jest.spyOn(fsp, 'readFile').mockImplementation(async (target, ...rest) => (
      target === '/proc/sys/kernel/random/boot_id' ? `${boot}\n` : readFile(target, ...rest)));
    await expect(paths().hostIdentity()).resolves.toEqual({ host, bootId: boot });
    expect(read.mock.calls.map(call => call[0])).not.toContain('/etc/machine-id');
  });
});

describe('drain deadline and request tracking switch', () => {
  it('gives up after the timeout without touching the work, and drains fully once it ends', async () => {
    const work = require('../../src/services/activeApplicationWork').createWorkRegistry();
    let finish;
    const running = work.track('long download', () => new Promise(resolve => { finish = resolve; }));
    const started = Date.now();
    await expect(work.drain({ timeoutMs: 40 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(work.pendingCount()).toBe(1);
    finish();
    await running;
    await expect(work.drain({ timeoutMs: 40 })).resolves.toBe(true);
    await expect(work.drain()).resolves.toBe(true);
  });

  it('passes every request straight through while tracking is switched off, even with admission closed', () => {
    const { createApplicationWorkMiddleware } = require('../../src/middleware/applicationWork');
    const work = require('../../src/services/activeApplicationWork').createWorkRegistry();
    work.closeAdmission();
    const track = jest.spyOn(work, 'track');
    let enabled = false;
    const middleware = createApplicationWorkMiddleware({ work, enabled: () => enabled });
    const next = jest.fn();
    middleware({}, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalled();
    enabled = true;
    const res = { status: jest.fn(() => res), json: jest.fn() };
    middleware({}, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('restarts with their own start functions exactly the services a restore stopped', async () => {
    const shutdown = require('../../src/services/serviceShutdown');
    const queue = require('../../src/services/faceQueue');
    const start = jest.spyOn(queue, 'start').mockImplementation(() => {});
    const stop = jest.spyOn(queue, 'stop').mockImplementation(async () => {});
    await shutdown.stopServices();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    await shutdown.resumeServices();
    expect(start).toHaveBeenCalledTimes(1);
    start.mockImplementation(() => { throw new Error('queue refused to start'); });
    await expect(shutdown.resumeServices()).rejects.toThrow('Service restart failed');
  });
});

describe('installs that never use the feature', () => {
  it('local storage starts without reading the S3 generation index', async () => {
    const index = require('../../src/services/storage/generationIndex');
    const read = jest.spyOn(index, 'readRows');
    const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
    const backend = new LocalFsStorage({ root: process.env.STORAGE_PATH });
    await backend.init();
    expect(backend.kind()).toBe('local');
    expect(read).not.toHaveBeenCalled();
  });

  it('names only runtime tables that exist as tables the export leaves out', () => {
    expect(require('../../src/utils/restoreRuntimeTables')).toEqual(['portable_restore_control', 'portable_restore_instances',
      'portable_restore_commits', 'storage_s3_generation_index', 'media_process_attempts']);
  });
});

describe('import limits', () => {
  it('reads a row far larger than the former 1 MiB cap, and the environment raises the default', async () => {
    const rows = require('../../src/services/portableImportRows');
    expect(rows.MAX_ROW_BYTES).toBe(64 * 1024 * 1024);
    const file = path.join(directory, 'email_queue.ndjson');
    const row = { id: 1, html_body: 'x'.repeat(3 * 1024 * 1024) };
    await fsp.writeFile(file, `${JSON.stringify(row)}\n`);
    const read = [];
    for await (const item of rows.readNdjson(file)) read.push(item.row.html_body.length);
    expect(read).toEqual([3 * 1024 * 1024]);
    process.env.PICPEAK_IMPORT_MAX_ROW_BYTES = String(1024 * 1024);
    await expect((async () => { for await (const item of rows.readNdjson(file)) read.push(item); })())
      .rejects.toMatchObject({ code: 'PICPEAK_IMPORT_ROW_LIMIT', statusCode: 413 });
    process.env.PICPEAK_IMPORT_MAX_ROW_BYTES = String(128 * 1024 * 1024);
    expect(rows.rowByteLimit()).toBe(128 * 1024 * 1024);
  });

  it('warns at export time about anything beyond what an importer accepts by default', () => {
    const { importLimitWarnings } = require('../../src/services/picpeakExportService');
    expect(importLimitWarnings({ entries: 150000, expandedBytes: 200 * 1024 ** 3, manifestBytes: 30 * 1024 * 1024, largestRowBytes: 3 * 1024 * 1024 })).toEqual([]);
    const warnings = importLimitWarnings({ entries: 2000001, expandedBytes: 1024 ** 4 + 1, manifestBytes: 256 * 1024 * 1024 + 1, largestRowBytes: 64 * 1024 * 1024 + 1 });
    expect(warnings).toHaveLength(4);
    for (const name of ['PICPEAK_IMPORT_MAX_ENTRIES', 'PICPEAK_IMPORT_MAX_EXPANDED_BYTES', 'PICPEAK_IMPORT_MAX_MANIFEST_BYTES', 'PICPEAK_IMPORT_MAX_ROW_BYTES']) {
      expect(warnings.some(warning => warning.includes(name))).toBe(true);
    }
  });
});

describe('restore journal under the cutover lock', () => {
  const policy = key => !key.startsWith('business-docs/') && 'Not a portable managed file';
  let root, source;
  const put = async (base, name, value) => {
    await fsp.mkdir(path.dirname(path.join(base, name)), { recursive: true });
    await fsp.writeFile(path.join(base, name), value, { mode: 0o600 });
  };
  beforeEach(async () => {
    jest.spyOn(fsp, 'statfs').mockResolvedValue(EXT4);
    root = path.join(directory, 'storage');
    source = path.join(directory, 'source');
    await fsp.mkdir(source);
    await put(root, 'business-docs/a.dat', 'original');
    await put(source, 'business-docs/a.dat', 'restored-a');
    await put(source, 'business-docs/b.dat', 'restored-b');
  });

  it('promotes a journal it prepared with renames alone: no file is hashed again', async () => {
    const { PortableRestoreJournal } = require('../../src/services/portableRestoreJournal');
    const journal = await PortableRestoreJournal.create({ storageRoot: root, validateKey: policy });
    await journal.prepare(source, ['business-docs/a.dat', 'business-docs/b.dat']);
    const hashes = jest.spyOn(crypto, 'createHash');
    await journal.promote(source);
    await journal.verifyPromoted();
    // Only the small plan file is hashed under the lock, never a media file.
    expect(hashes).toHaveBeenCalledTimes(1);
    hashes.mockRestore();
    expect(await fsp.readFile(path.join(root, 'business-docs/a.dat'), 'utf8')).toBe('restored-a');
    expect(await fsp.readFile(path.join(root, 'business-docs/b.dat'), 'utf8')).toBe('restored-b');
    // The full checksum pass still exists, for after the lock is released.
    await journal.verifyCommitted();
    await fsp.writeFile(path.join(root, 'business-docs/b.dat'), 'tampered-b');
    await expect(journal.verifyCommitted()).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    await fsp.truncate(path.join(root, 'business-docs/b.dat'), 3);
    await expect(journal.verifyPromoted()).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
  });

  it('still refuses to promote over a live file that changed after it was staged', async () => {
    const { PortableRestoreJournal } = require('../../src/services/portableRestoreJournal');
    const journal = await PortableRestoreJournal.create({ storageRoot: root, validateKey: policy });
    await journal.prepare(source, ['business-docs/a.dat']);
    await fsp.writeFile(path.join(root, 'business-docs/a.dat'), 'changed while staged');
    await expect(journal.promote(source)).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    expect(await fsp.readFile(path.join(root, 'business-docs/a.dat'), 'utf8')).toBe('changed while staged');
  });

  it('hashes everything again for a journal loaded from disk (recovery by another process)', async () => {
    const { PortableRestoreJournal } = require('../../src/services/portableRestoreJournal');
    const prepared = await PortableRestoreJournal.create({ storageRoot: root, validateKey: policy });
    await prepared.prepare(source, ['business-docs/a.dat', 'business-docs/b.dat']);
    const loaded = await PortableRestoreJournal.load({ storageRoot: root, id: prepared.id, validateKey: policy });
    const hashes = jest.spyOn(crypto, 'createHash');
    await loaded.promote(source);
    expect(hashes.mock.calls.length).toBeGreaterThan(4);
    hashes.mockRestore();
    await loaded.rollback();
    expect(await fsp.readFile(path.join(root, 'business-docs/a.dat'), 'utf8')).toBe('original');
    await expect(fsp.stat(path.join(root, 'business-docs/b.dat'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts as many files and bytes as the archive limits admit', () => {
    const journal = require('../../src/services/portableRestoreJournal');
    expect(journal.maxFiles()).toBe(2000000);
    expect(journal.maxBytes()).toBe(2 * 1024 ** 4);
  });
});
