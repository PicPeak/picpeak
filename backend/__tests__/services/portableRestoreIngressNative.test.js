'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const restorePaths = require('../../src/services/portableRestorePaths');
const { createIngress } = require('../../src/services/portableRestoreIngress');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const linux = process.platform === 'linux' ? describe : describe.skip;

linux('actual Node-held shared restore ingress lease', () => {
  let directory, previous, storage, native;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-native-ingress-')));
    previous = process.env.STORAGE_PATH; process.env.STORAGE_PATH = path.join(directory, 'storage');
    storage = await restorePaths.storageIdentity({ create: true });
    // No test/environment fallback: a missing Linux addon is a real failure.
    native = require('../../src/services/linuxKernelLease');
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.STORAGE_PATH; else process.env.STORAGE_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function attempt() { return path.join(await restorePaths.attemptDirectory(crypto.randomUUID(), { create: true }), 'request.picpeak'); }

  it('actual pending FileHandle reads and cleanup keep the native FD BUSY until terminal', async () => {
    const source = path.join(directory, 'source.picpeak'); await fs.writeFile(source, Buffer.alloc(100000));
    const target = await attempt(); const entered = gate(), finish = gate(); let copying;
    const filesystem = new Proxy(fs, { get: (parent, key) => key === 'open' ? async (filename, ...args) => {
      const handle = await parent.open(filename, ...args);
      if (filename !== source) return handle;
      return new Proxy(handle, { get: (value, method) => method === 'read' ? async (...readArgs) => {
        entered.resolve(); await finish.promise; return value.read(...readArgs);
      } : typeof value[method] === 'function' ? value[method].bind(value) : value[method] });
    } : parent[key] });
    const ingress = createIngress({ filesystem });
    const lifetime = ingress.withIngress(async () => {
      copying = ingress.copyArchive({ sourcePath: source, destinationPath: target }); await entered.promise;
    });
    await entered.promise;
    const leasePath = path.join(storage.privateRoot, 'upload.lease'), stat = await fs.stat(leasePath);
    const expected = { device: String(stat.dev), inode: String(stat.ino), filesystem: storage.filesystem };
    expect(await native.probe(leasePath, expected)).toBe('busy');
    await expect(createIngress().withIngress(async () => {})).rejects.toMatchObject({ code: 'MEDIA_LEASE_BUSY' });
    let drained = false; const drain = ingress.drain().then(() => { drained = true; });
    await new Promise(done => setImmediate(done)); expect(drained).toBe(false);
    finish.resolve(); await Promise.all([lifetime, copying, drain]);
    expect(await native.probe(leasePath, expected)).toBe('free');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('another actual Node process cannot acquire the same persistent upload slot', async () => {
    const ingress = createIngress();
    await ingress.withIngress(async () => {
      execFileSync(process.execPath, ['-e', `
        const native = require('./src/services/linuxKernelLease');
        native.acquire(process.argv[1]).then(() => {process.exitCode=1;}, error => {
          if(error.code!=='MEDIA_LEASE_BUSY') throw error;
        });
      `, path.join(storage.privateRoot, 'upload.lease')], { cwd: path.resolve(__dirname, '../..'), timeout: 5000 });
    });
  });

  it('an operator source on a different readonly local mount does not weaken target volume checks', async () => {
    const sourceDirectory = await fs.mkdtemp('/dev/shm/picpeak-ingress-source-');
    try {
      const source = path.join(sourceDirectory, 'source.picpeak'); await fs.writeFile(source, 'different source device', { mode: 0o400 });
      expect(String((await fs.stat(source)).dev)).not.toBe(storage.device);
      const target = await attempt(); const ingress = createIngress();
      await ingress.withIngress(async () => { (await ingress.copyArchive({ sourcePath: source, destinationPath: target })).retain(); });
      expect(String((await fs.stat(target)).dev)).toBe(storage.device);
      expect(await fs.readFile(target, 'utf8')).toBe('different source device');
    } finally { await fs.rm(sourceDirectory, { recursive: true, force: true }); }
  });
});
