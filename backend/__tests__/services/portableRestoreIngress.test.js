'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const { fixtureIngress } = require('../integration/helpers/restoreIngress');
const { createIngress, MAX_ARCHIVE_BYTES, RESERVE_BYTES, RESERVE_INODES } = require('../../src/services/portableRestoreIngress');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe('bounded private restore ingress lifetime', () => {
  let directory, fixture, sourcePath, destinationPath;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-ingress-')));
    fixture = await fixtureIngress(path.join(directory, '.picpeak-maintenance'));
    sourcePath = path.join(directory, 'source.picpeak');
    await fs.writeFile(sourcePath, Buffer.alloc(150000, 17), { mode: 0o600 });
    const attempt = path.join(fixture.storage.privateRoot, crypto.randomUUID());
    await fs.mkdir(attempt, { mode: 0o700 });
    destinationPath = path.join(attempt, 'request.picpeak');
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const copy = ingress => ingress.withIngress(() => ingress.copyArchive({ sourcePath, destinationPath }));
  const inject = overrides => createIngress({ ...fixture, filesystem: new Proxy(fixture.filesystem,
    { get: (target, key) => overrides[key] || target[key] }) });

  it('copies with bounded FileHandle I/O, preserves private retained staging and releases only after cleanup', async () => {
    await fixture.ingress.withIngress(async () => {
      const staged = await fixture.ingress.copyArchive({ sourcePath, destinationPath });
      expect(staged.bytes).toBe(150000); staged.retain();
      expect(fixture.acquired[0].released).not.toBe(true);
    });
    expect(await fs.readFile(destinationPath)).toEqual(await fs.readFile(sourcePath));
    expect((await fs.stat(destinationPath)).mode & 0o777).toBe(0o600);
    expect(fixture.acquired[0].released).toBe(true);
  });

  it('removes only its own unclaimed copy before releasing the ingress lease', async () => {
    await copy(fixture.ingress);
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.acquired[0].released).toBe(true);
  });

  it('never deletes a preexisting destination on O_EXCL failure', async () => {
    await fs.writeFile(destinationPath, 'unrelated original', { mode: 0o600 });
    await expect(copy(fixture.ingress)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('unrelated original');
    expect(fixture.acquired[0].released).toBe(true);
  });

  it.each(['empty', 'symlink', 'hardlink', 'oversize'])('rejects %s sources before admitting their copy', async kind => {
    if (kind === 'empty') await fs.truncate(sourcePath, 0);
    if (kind === 'oversize') await fs.truncate(sourcePath, MAX_ARCHIVE_BYTES + 1);
    if (kind === 'hardlink') await fs.link(sourcePath, `${sourcePath}.link`);
    if (kind === 'symlink') { await fs.rename(sourcePath, `${sourcePath}.real`); await fs.symlink(`${sourcePath}.real`, sourcePath); }
    await expect(copy(fixture.ingress)).rejects.toBeDefined();
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.acquired[0].released).toBe(true);
  });

  it('rejects a non-private attempt directory', async () => {
    await fs.chmod(path.dirname(destinationPath), 0o755);
    await expect(copy(fixture.ingress)).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
  });

  it.each([['statfs failure', () => { throw new Error('unknown measurement'); }],
    ['missing measurement', () => ({ bavail: 1n, bsize: 4n })],
    ['missing inodes', () => ({ type: 0xef53n, bavail: BigInt(RESERVE_BYTES), bsize: 1n })],
    ['invalid block size', () => ({ type: 0xef53n, bavail: 1000000000n, bsize: 0n, ffree: 100000n })]])(
    '%s remains finite and returns capacity-unavailable 507', async (_name, statfs) => {
      await expect(copy(inject({ statfs }))).rejects.toMatchObject({ code: 'RESTORE_CAPACITY_UNKNOWN', statusCode: 507 });
      expect(fixture.acquired[0].released).toBe(true);
    });

  it.each([['bytes', { bavail: BigInt(RESERVE_BYTES - 1), ffree: 100000n }],
    ['inodes', { bavail: 1000000000n, ffree: BigInt(RESERVE_INODES - 1) }]])('retains the fixed %s reserve', async (_name, stats) => {
    await expect(copy(inject({ statfs: async () => ({ type: 0xef53n, bsize: 1n, ...stats }) })))
      .rejects.toMatchObject({ code: 'RESTORE_CAPACITY_LIMIT', statusCode: 507 });
  });

  it('positively unsupported filesystems remain unsafe rather than unknown capacity', async () => {
    await expect(copy(inject({ statfs: async () => ({ type: 0x6969n }) })))
      .rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE', statusCode: 503 });
  });

  it('detects source growth without allocating or writing beyond its measured initial size', async () => {
    let changed = false;
    const ingress = inject({ open: async (filename, ...args) => {
      const handle = await fixture.filesystem.open(filename, ...args);
      if (filename !== sourcePath) return handle;
      return new Proxy(handle, { get: (target, key) => key === 'read' ? async (...readArgs) => {
        if (!changed) { changed = true; await fs.appendFile(sourcePath, Buffer.from('changed')); }
        return target.read(...readArgs);
      } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
    } });
    await expect(copy(ingress)).rejects.toMatchObject({ code: 'RESTORE_ARCHIVE_INVALID', statusCode: 400 });
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a canceled owner waits pending reads, file close and cleanup before terminal/release', async () => {
    const entered = gate(), finish = gate(); let readPending = false, closedPending = false, finished = false;
    const ingress = inject({ open: async (filename, ...args) => {
      const handle = await fixture.filesystem.open(filename, ...args);
      if (filename !== sourcePath) return handle;
      return new Proxy(handle, { get: (target, key) => key === 'read' ? async (...readArgs) => {
        readPending = true; entered.resolve(); await finish.promise; readPending = false;
        return target.read(...readArgs);
      } : key === 'close' ? async () => { closedPending = readPending; return target.close(); }
        : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
    } });
    let copying;
    const lifetime = ingress.withIngress(async () => {
      copying = ingress.copyArchive({ sourcePath, destinationPath });
      await entered.promise;
      // Simulate a caller returning/closing with accepted I/O still pending.
    }).then(() => { finished = true; });
    await entered.promise;
    let drained = false; const drain = ingress.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false); expect(drained).toBe(false); expect(fixture.acquired[0].released).not.toBe(true);
    finish.resolve(); await Promise.all([lifetime, copying, drain]);
    expect(closedPending).toBe(false); expect(fixture.acquired[0].released).toBe(true);
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the internal reentrant copy uses the same live lease, while parallel contenders are denied', async () => {
    await fixture.ingress.withIngress(async () => {
      await fixture.ingress.withIngress(async () => { expect(fixture.acquired).toHaveLength(1); });
      // A fresh isolate has no internal ALS capability and must acquire the FD.
      await expect(createIngress(fixture).withIngress(async () => {})).rejects.toMatchObject({ code: 'MEDIA_LEASE_BUSY' });
    });
    expect(fixture.acquired).toHaveLength(1);
  });

  it('multipart storage measures actual bytes and owns complete cleanup', async () => {
    await fixture.ingress.withIngress(async () => {
      const req = new EventEmitter();
      const file = { stream: Readable.from([Buffer.alloc(100000, 29)]) };
      const stored = await new Promise((resolve, reject) => fixture.ingress.storage()._handleFile(req, file,
        (failure, result) => failure ? reject(failure) : resolve(result)));
      expect(stored.size).toBe(100000);
      expect(stored.path).toContain(path.join(fixture.storage.privateRoot, 'uploads'));
      expect((await fs.stat(stored.path)).mode & 0o777).toBe(0o600);
    });
    expect(await fs.readdir(path.join(fixture.storage.privateRoot, 'uploads'))).toEqual([]);
  });

  it('aborted upload never becomes a completed archive, and pending storage closes before release', async () => {
    await expect(fixture.ingress.withIngress(async () => {
      const req = new EventEmitter(); req.aborted = true;
      const file = { stream: new Readable({ read() {} }) };
      await new Promise((resolve, reject) => fixture.ingress.storage()._handleFile(req, file,
        (failure, result) => failure ? reject(failure) : resolve(result)));
    })).rejects.toMatchObject({ code: 'RESTORE_UPLOAD_ABORTED' });
    expect(fixture.acquired[0].released).toBe(true);
    expect(await fs.readdir(path.join(fixture.storage.privateRoot, 'uploads'))).toEqual([]);
  });

  it('replaced cleanup identity is never deleted or treated as terminal', async () => {
    await expect(fixture.ingress.withIngress(async () => {
      await fixture.ingress.copyArchive({ sourcePath, destinationPath });
      await fs.rename(destinationPath, `${destinationPath}.original`);
      await fs.writeFile(destinationPath, 'replacement', { mode: 0o600 });
    })).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('replacement');
    expect(fixture.acquired[0].released).not.toBe(true);
    await expect(fixture.ingress.drain()).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNSAFE' });
  });
});
