/**
 * A failed pre-zip build must not leave storage reads open.
 *
 * The builder opened one storage read per photo and handed the raw stream to
 * archiver. archiver drains its queue one entry at a time, so on an S3 backend
 * every photo beyond the one being written parked a socket with a full receive
 * buffer, and the error path (a source stream dying, or a photo upload
 * invalidating the build) walked away from all of them. archiver's abort()
 * does not touch the source streams, and the AWS SDK arms its socket timeout
 * on a 3s delay then clears it once the response headers arrive, so nothing
 * ever reclaimed those sockets. On a live server 43 of the 50 pooled sockets
 * ended up stuck for days and photo uploads stopped completing.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipleak-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'zipleak-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zipleak-storage-'));

const { Readable } = require('stream');

const PHOTO_COUNT = 6;
const MAX_INFLIGHT_READS = 2;

// One storage read. It never ends on its own, which is what a large photo
// looks like to the builder: the bytes only move while archiver pulls them.
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

const reads = { opened: [], live: 0, peak: 0 };
const failingKey = { value: null };
const onOpen = { fn: null };
// A read only finishes when the build pulls the whole object. Photos big
// enough to matter never finish inside one archiver turn, and a stream that
// ends on its own would be auto-destroyed and hide the leak.
const objectChunks = { value: Number.POSITIVE_INFINITY };

function openStoredObject(key) {
  const stream = new StoredObject(key, key === failingKey.value ? 1 : 0, objectChunks.value);
  reads.opened.push(stream);
  reads.live += 1;
  if (reads.live > reads.peak) reads.peak = reads.live;
  let settled = false;
  const settle = () => { if (!settled) { settled = true; reads.live -= 1; } };
  stream.once('end', settle);
  stream.once('close', settle);
  if (onOpen.fn) onOpen.fn(reads.opened.length);
  return stream;
}

const mockStorage = {
  kind: () => 's3',
  get: jest.fn(async (key) => openStoredObject(key)),
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
// branch, which is the one that holds sockets.
jest.mock('../../src/services/downloadRendition', () => ({
  renderPhotoForDownload: jest.fn(async () => null),
  resolveWatermarkSettings: jest.fn(async () => null),
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const downloadZipService = require('../../src/services/downloadZipService');

describe('pre-zip build releases its storage reads', () => {
  let db; let cleanup; let eventId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: 'zipleak',
      event_type: 'wedding',
      event_name: 'Zip Leak',
      event_date: '2026-09-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: '/gallery/zipleak/s',
      share_token: 'zipleak-share',
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
        path: `zipleak/photo-${i}.jpg`,
        type: 'individual',
        source_origin: 'managed',
        mime_type: 'image/jpeg',
        visibility: 'visible',
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    reads.opened = [];
    reads.live = 0;
    reads.peak = 0;
    failingKey.value = null;
    onOpen.fn = null;
    objectChunks.value = Number.POSITIVE_INFINITY;
    mockStorage.get.mockClear();
    downloadZipService.versions.clear();
    downloadZipService.activeBuilds.clear();
  });

  it('destroys every open read when a source stream dies mid-build', async () => {
    // The oldest photo is written first, so failing it strands the rest.
    failingKey.value = 'events/active/zipleak/photo-0.jpg';

    const result = await downloadZipService.generateZip(eventId);

    expect(result.success).toBe(false);
    expect(reads.opened.length).toBeGreaterThan(1);
    const stranded = reads.opened.filter((s) => !s.destroyed);
    expect(stranded.map((s) => s.key)).toEqual([]);
  });

  it('destroys every open read when an upload invalidates the build', async () => {
    // What adminPhotos does on every upload, delete and bulk edit, landing
    // while the archive is half built.
    onOpen.fn = (count) => {
      if (count !== 2) return;
      downloadZipService.invalidate(eventId);
      // invalidate() also schedules a rebuild; this test is not about that.
      clearTimeout(downloadZipService.debounceTimers.get(eventId));
      downloadZipService.debounceTimers.delete(eventId);
    };

    const result = await downloadZipService.generateZip(eventId);

    expect(result).toEqual({ success: false, error: 'Build invalidated' });
    expect(reads.opened.filter((s) => !s.destroyed).map((s) => s.key)).toEqual([]);
  });

  it('never holds more storage reads open than the build needs', async () => {
    objectChunks.value = 8;

    const result = await downloadZipService.generateZip(eventId);

    expect(result.success).toBe(true);
    expect(mockStorage.get).toHaveBeenCalledTimes(PHOTO_COUNT);
    expect(reads.peak).toBeLessThanOrEqual(MAX_INFLIGHT_READS);
  });
});
