'use strict';
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const Local = require('../../src/services/storage/LocalFsStorage');
const { upload, verify, withVerifiedFile } = require('../../src/services/printSales/files');
const zip = require('../../src/services/printSales/pack');
let root, storage;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'print-stream-test-'));
  storage = new Local({ root });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function asset(bytes = Buffer.from('synthetic artwork')) {
  await storage.put('artwork', bytes);
  return { storage_key: 'artwork', size: bytes.length, sha256: hash(bytes) };
}
test('uploads a generated 96 MiB stream without requiring a whole-file buffer', async () => {
  const chunk = Buffer.alloc(64 * 1024, 73), digest = crypto.createHash('sha256');
  const source = Readable.from((async function* () {
    for (let n = 0; n < 1536; n++) { digest.update(chunk); yield chunk; }
  })(), { objectMode: false });
  const identity = await upload(storage, 'large', source, 128 * 1024 * 1024);
  expect(identity).toEqual({ size: 96 * 1024 * 1024, sha256: digest.digest('hex') });
  await expect(verify(storage, { storage_key: 'large', ...identity })).resolves.toBeUndefined();
});
test('a read failure aborts upload and leaves no published file', async () => {
  const source = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('read failed'); })());
  await expect(upload(storage, 'partial', source, 100)).rejects.toThrow('read failed');
  expect(await storage.exists('partial')).toBe(false);
  expect(await fs.readdir(root)).toEqual([]);
});
test('a destination failure closes the source and cleans up after the write settles', async () => {
  const source = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
  storage.put = async (_key, input) => { input.once('data', () => input.destroy(new Error('write failed'))); for await (const _ of input) { /* consume */ } };
  await expect(upload(storage, 'failed', source, 100000)).rejects.toThrow('write failed');
  expect(source.destroyed).toBe(true);
  expect(await storage.exists('failed')).toBe(false);
});
test('an oversized upload stops and removes its partial object', async () => {
  await expect(upload(storage, 'large', Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15))
    .rejects.toThrow('file limit');
  expect(await storage.exists('large')).toBe(false);
});
test.each(['length', 'digest'])('refuses a changed %s before calling the browser consumer', async change => {
  const a = await asset();
  await storage.put(a.storage_key, Buffer.from(change === 'length' ? 'short' : 'synthetic artworX'));
  const consume = jest.fn();
  await expect(withVerifiedFile(storage, a, consume)).rejects.toThrow('file changed');
  expect(consume).not.toHaveBeenCalled();
});
test('the verified download is private and cleaned up after a disconnected consumer', async () => {
  const a = await asset(); let file;
  await expect(withVerifiedFile(storage, a, async (stream, size) => {
    file = stream.path;
    expect(size).toBe(a.size);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await storage.put(a.storage_key, Buffer.from('changed after verification'));
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    expect(hash(Buffer.concat(chunks))).toBe(a.sha256);
    throw new Error('client disconnected');
  })).rejects.toThrow('client disconnected');
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});
test('a cancelled download releases its slot without starting a browser response', async () => {
  const a = await asset(), controller = new AbortController(), consume = jest.fn(); controller.abort();
  await expect(withVerifiedFile(storage, a, consume, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(consume).not.toHaveBeenCalled();
  await expect(withVerifiedFile(storage, a, async stream => { for await (const _ of stream) { /* drain */ } })).resolves.toBeUndefined();
});

test('streams a supplier ZIP with lazy verified sources and no private sheet', async () => {
  const entries = [];
  for (let i = 0; i < 20; i++) {
    const bytes = Buffer.alloc(1024 * 64, i), key = `source-${i}`;
    await storage.put(key, bytes);
    entries.push({ name: `${i}.jpg`, asset: { storage_key: key, sha256: hash(bytes), size: bytes.length } });
  }
  const original = storage.get.bind(storage); let active = 0, peak = 0;
  storage.get = async key => {
    active++; peak = Math.max(peak, active);
    const stream = await original(key); stream.once('close', () => { active--; }); return stream;
  };
  const identity = await upload(storage, 'pack.zip', zip(entries, Buffer.from('{}'), storage), 2 * 1024 * 1024);
  expect(peak).toBeLessThanOrEqual(2);
  expect(active).toBe(0);
  const Zip = require('node-stream-zip');
  const archive = new Zip.async({ file: path.join(root, 'pack.zip') });
  try {
    const packed = await archive.entries();
    expect(Object.keys(packed)).toHaveLength(21);
    expect(packed['order-sheet.pdf']).toBeUndefined();
    expect(identity.size).toBeGreaterThan(20 * 64 * 1024);
    expect(hash(await archive.entryData('10.jpg'))).toBe(entries[10].asset.sha256);
  } finally { await archive.close(); }
});
test('an artwork digest failure aborts the supplier ZIP upload', async () => {
  const a = await asset(); a.sha256 = hash(Buffer.from('different'));
  await expect(upload(storage, 'pack.zip', zip([{ name: '1.jpg', asset: a }], Buffer.from('{}'), storage), 10000))
    .rejects.toThrow('file changed');
  expect(await storage.exists('pack.zip')).toBe(false);
});

test('a slow consumer does not exhaust the source idle timeout', async () => {
  const { verifiedStream } = require('../../src/services/printSales/files');
  const chunks = Array.from({ length: 4 }, (_, n) => Buffer.alloc(256 * 1024, n)), bytes = Buffer.concat(chunks);
  const source = Readable.from(chunks, { objectMode: false });
  const output = verifiedStream({ get: async () => source }, { storage_key: 'synthetic', size: bytes.length, sha256: hash(bytes) }, { idleMs: 20 });
  const iterator = output[Symbol.asyncIterator](), first = await iterator.next();
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(source.destroyed).toBe(false);
  const received = [first.value]; for (let next = await iterator.next(); !next.done; next = await iterator.next()) received.push(next.value);
  expect(hash(Buffer.concat(received))).toBe(hash(bytes));
});
test('a source that stops producing data still times out', async () => {
  const { verifiedStream } = require('../../src/services/printSales/files');
  const source = new Readable({ read() {} });
  const output = verifiedStream({ get: async () => source }, { storage_key: 'stalled', size: 1, sha256: 'unused' }, { idleMs: 20 });
  await expect((async () => { for await (const _chunk of output) { /* consume */ } })()).rejects.toThrow('timed out');
  expect(source.destroyed).toBe(true);
});
test('aborting an upload waits for the storage cancellation before returning', async () => {
  const controller = new AbortController(), source = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
  let entered, finish, settled = false;
  const started = new Promise(resolve => { entered = resolve; });
  const destination = { put: async (_key, input, { signal }) => {
    entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => { finish = resolve; }); input.destroy();
  }, delete: jest.fn(async () => {}) };
  const pending = upload(destination, 'aborted', source, 100 * 1024 * 1024, { signal: controller.signal }).finally(() => { settled = true; });
  const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false); finish(); await failed;
  expect(destination.delete).toHaveBeenCalledWith('aborted'); expect(source.destroyed).toBe(true);
});
test('abandoned private copies expire while fresh, active and unrelated files are preserved', async () => {
  const { sweepDownloads } = require('../../src/services/printSales/files'), a = await asset();
  const old = await fs.mkdtemp(path.join(root, 'picpeak-print-download-')), fresh = await fs.mkdtemp(path.join(root, 'picpeak-print-download-'));
  await fs.utimes(old, new Date(0), new Date(0)); await fs.writeFile(path.join(old, 'verified'), 'private');
  await fs.utimes(old, new Date(0), new Date(0));
  const unrelated = path.join(root, 'keep-me'); await fs.mkdir(unrelated);
  await withVerifiedFile(storage, a, async stream => {
    const active = path.dirname(stream.path); await fs.utimes(active, new Date(0), new Date(0));
    await sweepDownloads({ directory: root });
    expect(await fs.stat(active)).toBeTruthy();
  }, { directory: root });
  await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.stat(fresh)).toBeTruthy(); expect(await fs.stat(unrelated)).toBeTruthy();
});

test('original capture permits a long transfer that continues making progress', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  let count = 0;
  const input = new Readable({ read() { setTimeout(() => { this.push(Buffer.from('x')); if (++count === 3) this.push(null); }, 30000); } });
  try {
    const checked = expect(require('../../src/services/printSales/orders').read({ get: async () => input }, 'synthetic', 10)).resolves.toEqual(Buffer.from('xxx'));
    await jest.advanceTimersByTimeAsync(90001); await checked;
  } finally { input.destroy(); jest.useRealTimers(); }
});
