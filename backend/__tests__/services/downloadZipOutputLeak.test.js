/**
 * A cancelled or failed pre-zip build must not keep its partial zip on disk.
 *
 * The builder streams the archive into a tmp file (`output`). When an upload
 * invalidates the build, failBuild() aborts the archive and the `finally`
 * destroys the storage reads and removes the tmp directory. archiver only
 * closes `output` once its active queue entry finishes, and an entry whose
 * source was destroyed never does — so the file was unlinked but stayed open,
 * and the disk blocks were held until the Node process exited. A bulk upload
 * cancels one build per batch: on a live server 415 photos left 17 partial
 * zips (~18 GB) pinned as deleted-but-open files, and `df` reported far more
 * used space than `du` could find.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipout-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'zipout-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipout-storage-'));

const { Readable } = require('stream');

const PHOTO_COUNT = 6;
const CACHE_KEY = 'events/active/zipout/.download-cache/all.zip';

// One storage read. By default it never ends on its own, which is what a large
// photo looks like to the builder: the bytes only move while archiver pulls
// them. A stream that ended by itself would be auto-destroyed and hide the leak.
class StoredObject extends Readable {
  constructor(key, failAfterReads, chunks) {
    super();
    this.key = key;
    this.failAfterReads = failAfterReads;
    this.chunks = chunks;
    this.reads = 0;
  }

  _read() {
    this.reads += 1;
    if (this.failAfterReads && this.reads > this.failAfterReads) {
      // What a dropped connection to S3 looks like in Node.
      this.destroy(new Error('aborted'));
      return;
    }
    this.push(this.reads > this.chunks ? null : Buffer.alloc(4096, 1));
  }
}

const opened = { count: 0 };
const failingKey = { value: null };
const onOpen = { fn: null };
const objectChunks = { value: Number.POSITIVE_INFINITY };

const mockStorage = {
  kind: () => 's3',
  get: jest.fn(async (key) => {
    opened.count += 1;
    if (onOpen.fn) await onOpen.fn(opened.count);
    return new StoredObject(key, key === failingKey.value ? 1 : 0, objectChunks.value);
  }),
  getToFile: jest.fn(async () => undefined),
  putFromFile: jest.fn(async () => undefined),
  stat: jest.fn(async () => ({ size: 1234, mtime: new Date() })),
  delete: jest.fn(async () => undefined),
  exists: jest.fn(async () => true),
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

// Nothing to resize or watermark, so the builder takes the stream-from-storage
// branch.
jest.mock('../../src/services/downloadRendition', () => ({
  renderPhotoForDownload: jest.fn(async () => null),
  resolveWatermarkSettings: jest.fn(async () => null),
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const downloadZipService = require('../../src/services/downloadZipService');

// The tmp zip streams the builder opens, in creation order.
const outputs = [];
const realCreateWriteStream = fs.createWriteStream;

// Partial zips this process still holds open after unlinking them.
function leakedZipFds() {
  return fs.readdirSync('/proc/self/fd')
    .map((fd) => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch (_) { return ''; }
    })
    .filter((target) => target.includes('picpeak-zipbuild-') && target.endsWith('(deleted)'));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// What adminPhotos does on every upload, delete and bulk edit, landing while
// the archive is half built. invalidate() also schedules a rebuild, which
// these tests are not about.
function invalidateWithoutRebuild(eventId) {
  downloadZipService.invalidate(eventId);
  clearTimeout(downloadZipService.debounceTimers.get(eventId));
  downloadZipService.debounceTimers.delete(eventId);
}

describe('pre-zip build releases its tmp zip', () => {
  let db; let cleanup; let eventId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: 'zipout',
      event_type: 'wedding',
      event_name: 'Zip Output',
      event_date: '2026-09-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: '/gallery/zipout/s',
      share_token: 'zipout-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    for (let i = 0; i < PHOTO_COUNT; i += 1) {
      await db('photos').insert({
        event_id: eventId,
        filename: `photo-${i}.jpg`,
        path: `zipout/photo-${i}.jpg`,
        type: 'individual',
        source_origin: 'managed',
        mime_type: 'image/jpeg',
        visibility: 'visible',
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    opened.count = 0;
    failingKey.value = null;
    onOpen.fn = null;
    objectChunks.value = Number.POSITIVE_INFINITY;
    outputs.length = 0;
    mockStorage.get.mockClear();
    mockStorage.putFromFile.mockClear();
    mockStorage.delete.mockClear();
    mockStorage.stat.mockClear();
    downloadZipService.versions.clear();
    downloadZipService.activeBuilds.clear();
    await db('events').where({ id: eventId }).update({
      download_zip_path: null,
      download_zip_generated_at: null,
    });
    jest.spyOn(fs, 'createWriteStream').mockImplementation((file, ...rest) => {
      const stream = realCreateWriteStream.call(fs, file, ...rest);
      if (String(file).includes('picpeak-zipbuild-')) outputs.push({ stream, file: String(file) });
      return stream;
    });
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('closes the tmp zip and removes its directory when an upload invalidates the build', async () => {
    onOpen.fn = (count) => { if (count === 2) invalidateWithoutRebuild(eventId); };

    const result = await downloadZipService.generateZip(eventId);

    expect(result).toEqual({ success: false, error: 'Build invalidated' });
    expect(outputs).toHaveLength(1);
    expect(outputs[0].stream.destroyed).toBe(true);
    expect(fs.existsSync(path.dirname(outputs[0].file))).toBe(false);
  });

  it('closes the tmp zip when a source stream dies mid-build', async () => {
    // The oldest photo is written first, so failing it strands the rest.
    failingKey.value = 'events/active/zipout/photo-0.jpg';

    const result = await downloadZipService.generateZip(eventId);

    expect(result.success).toBe(false);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].stream.destroyed).toBe(true);
    expect(fs.existsSync(path.dirname(outputs[0].file))).toBe(false);
  });

  it('fails the build, and closes the tmp zip, when writing it fails', async () => {
    // ENOSPC on the tmp file is an 'error' on the write stream, which had no
    // listener at all: it surfaced as an uncaught exception, or as nothing
    // but a trailing 'close' that the build read as a finished zip.
    onOpen.fn = (count) => {
      if (count === 2) {
        outputs[0].stream.destroy(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
      }
    };

    const result = await downloadZipService.generateZip(eventId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOSPC/);
    expect(outputs[0].stream.destroyed).toBe(true);
    expect(fs.existsSync(path.dirname(outputs[0].file))).toBe(false);
  });

  (fs.existsSync('/proc/self/fd') ? it : it.skip)(
    'holds no deleted-but-open partial zips after a burst of cancelled builds',
    async () => {
      const before = leakedZipFds().length;

      // A bulk upload: every batch cancels the build the previous one started.
      for (let n = 0; n < 4; n += 1) {
        opened.count = 0;
        downloadZipService.versions.clear();
        downloadZipService.activeBuilds.clear();
        onOpen.fn = (count) => { if (count === 2) invalidateWithoutRebuild(eventId); };
        // eslint-disable-next-line no-await-in-loop
        const result = await downloadZipService.generateZip(eventId);
        expect(result).toEqual({ success: false, error: 'Build invalidated' });
      }

      await waitFor(() => leakedZipFds().length <= before);
      expect(leakedZipFds()).toHaveLength(before);
    },
  );

  it('still publishes a zip that nothing cancelled', async () => {
    objectChunks.value = 8;

    const result = await downloadZipService.generateZip(eventId);

    expect(result).toEqual({ success: true, key: CACHE_KEY, size: 1234 });
    expect(outputs[0].stream.destroyed).toBe(true);
    expect(fs.existsSync(path.dirname(outputs[0].file))).toBe(false);
    const row = await db('events').where({ id: eventId }).first();
    expect(row.download_zip_path).toBe(CACHE_KEY);
  });

  it('keeps the directory of a running build out of the stale-directory sweep', async () => {
    // A private tmp root, so the sweep cannot touch builds of other test files
    // running in parallel workers.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sweep-live-'));
    jest.spyOn(os, 'tmpdir').mockReturnValue(tmpRoot);
    let sweptMidBuild;
    let dirMidBuild;
    onOpen.fn = async (count) => {
      if (count !== 2) return;
      // minAgeMs 0: only the live-directory registry stands between the sweep
      // and the build's tmp directory.
      sweptMidBuild = await downloadZipService.sweepStaleBuildDirs({ minAgeMs: 0 });
      dirMidBuild = fs.existsSync(path.dirname(outputs[0].file));
    };
    objectChunks.value = 8;

    try {
      const result = await downloadZipService.generateZip(eventId);

      expect(result.success).toBe(true);
      expect(sweptMidBuild).toBe(0);
      expect(dirMidBuild).toBe(true);
      expect(downloadZipService.liveTmpDirs.size).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('sweepStaleBuildDirs', () => {
  let tmpRoot;

  // `fileAgeMs` defaults to the directory's: an abandoned build leaves both
  // untouched, while a running one keeps rewriting the file.
  const makeDir = (name, ageMs, fileAgeMs = ageMs) => {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir);
    const file = path.join(dir, 'abc-all.zip');
    fs.writeFileSync(file, 'partial');
    const fileWhen = new Date(Date.now() - fileAgeMs);
    fs.utimesSync(file, fileWhen, fileWhen);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sweep-'));
    jest.spyOn(os, 'tmpdir').mockReturnValue(tmpRoot);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    downloadZipService.liveTmpDirs.clear();
  });

  it('removes build directories left behind by an interrupted process', async () => {
    const stale = makeDir('picpeak-zipbuild-stale', 60 * 60 * 1000);
    const fresh = makeDir('picpeak-zipbuild-fresh', 1000);
    const unrelated = makeDir('some-other-tool', 60 * 60 * 1000);

    const removed = await downloadZipService.sweepStaleBuildDirs({ minAgeMs: 10 * 60 * 1000 });

    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('leaves a directory whose zip is still being written, by this or another process', async () => {
    // The directory itself stopped changing when the zip was created; the
    // file inside keeps getting newer mtimes as bytes are written.
    const writing = makeDir('picpeak-zipbuild-writing', 60 * 60 * 1000, 1000);

    const removed = await downloadZipService.sweepStaleBuildDirs({ minAgeMs: 10 * 60 * 1000 });

    expect(removed).toBe(0);
    expect(fs.existsSync(writing)).toBe(true);
  });

  it('leaves the directory of a build that is still running', async () => {
    const running = makeDir('picpeak-zipbuild-running', 60 * 60 * 1000);
    downloadZipService.liveTmpDirs.add(running);

    const removed = await downloadZipService.sweepStaleBuildDirs({ minAgeMs: 10 * 60 * 1000 });

    expect(removed).toBe(0);
    expect(fs.existsSync(running)).toBe(true);
  });

  it('does not throw when the tmp directory cannot be read', async () => {
    os.tmpdir.mockReturnValue(path.join(tmpRoot, 'does-not-exist'));

    await expect(downloadZipService.sweepStaleBuildDirs()).resolves.toBe(0);
  });
});
