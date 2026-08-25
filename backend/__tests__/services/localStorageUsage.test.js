/**
 * "Storage used" has to mean storage used (#1164).
 *
 * The tile summed photos.size_bytes, so on a reference-mode install it
 * reported the size of files sitting on a NAS — the reporter's read ~80 GB
 * against 21 GB of real local usage — while omitting everything PicPeak does
 * write locally, including an 11.8 GB download-cache zip.
 *
 * These pin the measurement against a real directory tree, since the whole
 * point is counting bytes that are actually there.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  measureLocalStorageUsage,
  resetLocalStorageUsageCache,
} = require('../../src/services/localStorageUsage');

describe('localStorageUsage (#1164)', () => {
  let root;

  const write = async (rel, bytes) => {
    const full = path.join(root, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, Buffer.alloc(bytes));
  };

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-usage-'));
    process.env.STORAGE_PATH = root;
    resetLocalStorageUsageCache();
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
    delete process.env.STORAGE_PATH;
    resetLocalStorageUsageCache();
  });

  it('counts every byte under the storage root', async () => {
    await write(path.join('events', 'active', 'wed', 'individual', 'a.jpg'), 1000);
    await write(path.join('thumbnails', 'a.jpg'), 100);
    await write(path.join('previews', 'a.jpg'), 300);

    const usage = await measureLocalStorageUsage();

    expect(usage.total).toBe(1400);
    expect(usage.files).toBe(3);
  });

  it('breaks the total down by what the bytes are', async () => {
    // The specific complaint: the derived artefacts PicPeak writes were
    // invisible, so "what is filling my disk" had no answer in the UI.
    await write(path.join('events', 'active', 'wed', 'individual', 'a.jpg'), 1000);
    await write(path.join('events', 'archived', 'old.zip'), 5000);
    await write(path.join('thumbnails', 'a.jpg'), 100);
    await write(path.join('previews', 'a.jpg'), 300);
    await write(path.join('heroes', 'a.jpg'), 200);
    await write(path.join('watermarks', 'a.jpg'), 700);
    await write(path.join('uploads', 'logo.png'), 50);

    const { breakdown } = await measureLocalStorageUsage();

    expect(breakdown).toMatchObject({
      originals: 1000,
      archives: 5000,
      thumbnails: 100,
      previews: 300,
      heroes: 200,
      watermarks: 700,
      uploads: 50,
    });
  });

  it('files the download cache separately from the originals it sits among', async () => {
    // `.download-cache` lives INSIDE the event directory, so the naive rule
    // files an 11.8 GB zip as photography. It is the one bucket that is pure
    // disposable cache and the one an admin most needs to see.
    await write(path.join('events', 'active', 'wed', 'individual', 'a.jpg'), 1000);
    await write(path.join('events', 'active', 'wed', '.download-cache', 'all.zip'), 9000);

    const { breakdown, total } = await measureLocalStorageUsage();

    expect(breakdown.downloadCache).toBe(9000);
    expect(breakdown.originals).toBe(1000);
    expect(total).toBe(10000);
  });

  it('counts orphans no database row knows about', async () => {
    // A deleted event's leftovers and an interrupted import's thumbnails are
    // real bytes on a real disk. Summing DB columns would miss them, which is
    // half of why this walks instead.
    await write(path.join('thumbnails', 'ext999_gone.jpg'), 777);

    expect((await measureLocalStorageUsage()).total).toBe(777);
  });

  it('reports zero on a fresh install rather than failing', async () => {
    const usage = await measureLocalStorageUsage();

    expect(usage.total).toBe(0);
    expect(usage.partial).toBe(false);
  });

  it('survives a storage root that does not exist', async () => {
    process.env.STORAGE_PATH = path.join(root, 'nope');
    resetLocalStorageUsageCache();

    const usage = await measureLocalStorageUsage();

    // ENOENT on the root is a fresh/misconfigured install, not a partial read.
    expect(usage.total).toBe(0);
    expect(usage.partial).toBe(false);
  });

  it('caches, and honours force', async () => {
    await write(path.join('thumbnails', 'a.jpg'), 100);
    expect((await measureLocalStorageUsage()).total).toBe(100);

    await write(path.join('thumbnails', 'b.jpg'), 400);
    // One stat per file is not free; the dashboard polls.
    expect((await measureLocalStorageUsage()).total).toBe(100);
    expect((await measureLocalStorageUsage({ force: true })).total).toBe(500);
  });

  it('does not follow a symlink out of the storage root', async () => {
    // A link into EXTERNAL_MEDIA_ROOT would add the NAS back into the local
    // total — reinstating the exact confusion this replaces.
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-nas-'));
    await fs.promises.writeFile(path.join(outside, 'huge.jpg'), Buffer.alloc(50000));
    await fs.promises.mkdir(path.join(root, 'events'), { recursive: true });
    await fs.promises.symlink(outside, path.join(root, 'events', 'nas'), 'dir');

    const usage = await measureLocalStorageUsage();

    expect(usage.total).toBe(0);
    await fs.promises.rm(outside, { recursive: true, force: true });
  });
});
