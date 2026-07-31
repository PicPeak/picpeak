/**
 * #931 — LocalFsStorage.putFromFile must be atomic. The old implementation
 * used fs.copyFile straight onto the destination, which truncates and
 * rewrites in place: a concurrent reader (thumbnail/watermark generation,
 * photo serving) could observe partial or foreign bytes mid-copy. The fix
 * copies to a sibling tmp file and renames, like put() always did.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const LocalFsStorage = require('../LocalFsStorage');

describe('LocalFsStorage.putFromFile', () => {
  let root;
  let srcDir;
  let storage;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-lfs-root-'));
    srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-lfs-src-'));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(srcDir, { recursive: true, force: true });
  });

  it('writes the source bytes to the destination key', async () => {
    const src = path.join(srcDir, 'a.jpg');
    await fsp.writeFile(src, Buffer.from('photo-a-bytes'));

    await storage.putFromFile('events/active/ev/a.jpg', src);

    const out = await fsp.readFile(path.join(root, 'events/active/ev/a.jpg'));
    expect(out.toString()).toBe('photo-a-bytes');
  });

  it('leaves no tmp files behind after a successful write', async () => {
    const src = path.join(srcDir, 'a.jpg');
    await fsp.writeFile(src, Buffer.from('photo-a-bytes'));

    await storage.putFromFile('events/active/ev/a.jpg', src);

    const entries = await fsp.readdir(path.join(root, 'events/active/ev'));
    expect(entries).toEqual(['a.jpg']);
  });

  it('leaves no tmp files behind when the source is missing', async () => {
    await expect(
      storage.putFromFile('events/active/ev/missing.jpg', path.join(srcDir, 'nope.jpg'))
    ).rejects.toThrow();

    const entries = await fsp.readdir(path.join(root, 'events/active/ev')).catch(() => []);
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('hides in-flight staging files from list()', async () => {
    const src = path.join(srcDir, 'a.jpg');
    await fsp.writeFile(src, Buffer.from('photo-a-bytes'));
    await storage.putFromFile('events/active/ev/a.jpg', src);

    // Simulate a concurrent writer's staging file: archiveEvent lists
    // this exact prefix and must never see (stream/delete) it.
    await fsp.writeFile(
      path.join(root, 'events/active/ev/b.jpg.tmp.12345.deadbeef'),
      Buffer.from('partial')
    );

    const keys = (await storage.list('events/active/ev')).map((e) => e.key ?? e);
    expect(JSON.stringify(keys)).toContain('a.jpg');
    expect(JSON.stringify(keys)).not.toContain('.tmp.');
  });

  it('reclaims stale orphaned staging files during list()', async () => {
    const dir = path.join(root, 'events/active/ev');
    await fsp.mkdir(dir, { recursive: true });
    const fresh = path.join(dir, 'f.jpg.tmp.111.aaaaaaaa');
    const stale = path.join(dir, 's.jpg.tmp.222.bbbbbbbb');
    await fsp.writeFile(fresh, Buffer.from('in-flight'));
    await fsp.writeFile(stale, Buffer.from('orphaned'));
    // Age the "stale" one past the reclaim threshold (1h).
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(stale, old, old);

    await storage.list('events/active/ev');

    // Fresh in-flight staging survives (a live copy may still rename it);
    // the crash orphan is gone.
    await expect(fsp.stat(fresh)).resolves.toBeDefined();
    await expect(fsp.stat(stale)).rejects.toThrow();
  });

  it('never exposes a partially written destination (tmp+rename atomicity)', async () => {
    // A large-ish payload so the copy is not a single instantaneous block.
    const big = Buffer.alloc(8 * 1024 * 1024, 0xab);
    const src = path.join(srcDir, 'big.bin');
    await fsp.writeFile(src, big);

    const key = 'events/active/ev/big.bin';
    const dest = path.join(root, key);

    // Poll the destination while the copy runs: it must either not exist
    // yet or already have the full size — never an in-between truncated
    // state (which is exactly what in-place copyFile produced).
    const observed = [];
    const poller = (async () => {
      for (let i = 0; i < 200; i++) {
        try {
          const st = fs.statSync(dest);
          observed.push(st.size);
        } catch {
          // not there yet — fine
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    await storage.putFromFile(key, src);
    await poller;

    for (const size of observed) {
      expect(size).toBe(big.length);
    }
    const out = await fsp.stat(dest);
    expect(out.size).toBe(big.length);
  });
});
