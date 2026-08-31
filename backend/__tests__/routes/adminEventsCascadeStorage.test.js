/**
 * Regression test: deleting an event must remove its stored objects.
 *
 * deleteEventCascade() cleaned up the local filesystem only (#608). On an
 * S3/R2 storage backend that cleanup is a no-op, so every deleted gallery
 * left its originals and derived tiers in the bucket — unreferenced,
 * invisible in the UI, and billed forever. Measured on a v3.45.16 install
 * against Cloudflare R2: deleting a 403-photo event changed the bucket
 * object count by exactly zero.
 *
 * The keys must be collected BEFORE the transaction deletes the photo
 * rows, because afterwards nothing knows which objects were this event's.
 */

const os = require('os');
const path = require('path');

// The cascade runs a real `fs.rm(..., { recursive: true })` over
// {STORAGE_PATH}/events/{active,archived}/{slug}. Point that at a throwaway
// directory before requiring the module under test — the default resolves
// into the working tree.
process.env.STORAGE_PATH = path.join(os.tmpdir(), 'picpeak-cascade-storage-test');

const mockStorage = { delete: jest.fn().mockResolvedValue(undefined) };

const mockEvent = {
  id: 42,
  slug: 'other-demo-2026-01-01',
  event_name: 'Demo',
  source_mode: 'managed',
  // Written through the backend by archiveService, so it is a bucket object
  // and the fs.unlink in the cascade never touched it on S3.
  archive_path: 'archives/other-demo-2026-01-01.zip',
  // The pre-built "Download All" zip. Lives under the event prefix, so the
  // recursive fs.rm covers it on local disk and nothing covers it on S3.
  download_zip_path: 'events/active/other-demo-2026-01-01/.download-cache/all.zip',
};

// One zip per custom-resolution download job, same prefix. The rows are
// ON DELETE CASCADE, so they must be read before the transaction.
const mockDownloadJobs = [
  { zip_path: 'events/active/other-demo-2026-01-01/.download-cache/job-abc123.zip' },
];
const mockPhotos = [
  {
    id: 1,
    path: 'other-demo-2026-01-01/photo_one.jpg',
    thumbnail_path: 'thumbnails/thumb_aaa_photo_one.jpg',
    hero_path: null,
    preview_path: 'previews/prev_aaa_photo_one.jpg',
    watermark_path: 'watermarked/wm_aaa_photo_one.jpg',
    source_origin: 'managed',
  },
  {
    id: 2,
    path: 'other-demo-2026-01-01/photo_two.jpg',
    thumbnail_path: 'thumbnails/thumb_bbb_photo_two.jpg',
    hero_path: null,
    preview_path: null,
    watermark_path: null,
    source_origin: 'managed',
  },
  {
    // External photos live outside the managed backend and must be left alone.
    id: 3,
    path: 'ignored.jpg',
    thumbnail_path: null,
    hero_path: null,
    preview_path: null,
    watermark_path: null,
    source_origin: 'external',
  },
];

let mockPhotoRowsDeleted = false;
let mockJobRowsDeleted = false;

// Photos in OTHER events that share a canonical derivative key with this one.
let mockSharedDerivatives = [];

// The shared-derivative probe: db('photos').whereNot(...).where(cb).select(...)
const sharedProbe = {
  where: () => sharedProbe,
  whereIn: () => sharedProbe,
  orWhereIn: () => sharedProbe,
  select: async () => mockSharedDerivatives,
};

function mockMakeDb() {
  const table = (name) => {
    const chain = {
      where: () => chain,
      first: async () => (name === 'events' ? mockEvent : undefined),
      whereNotNull: () => chain,
      whereNot: () => sharedProbe,
      orWhereIn: () => chain,
      whereIn: () => chain,
      select: async () => {
        if (name === 'download_jobs') {
          return mockJobRowsDeleted ? [] : mockDownloadJobs;
        }
        if (name === 'photos') {
          // The whole point: if this runs after the transaction, the rows
          // are gone and we would collect nothing.
          return mockPhotoRowsDeleted ? [] : mockPhotos;
        }
        return [];
      },
      del: async () => {
        if (name === 'photos') mockPhotoRowsDeleted = true;
        if (name === 'download_jobs') mockJobRowsDeleted = true;
        return 1;
      },
    };
    return chain;
  };
  // #1132 guards the merge-dismissals delete behind a hasTable check.
  table.schema = { hasTable: async (t) => t === 'download_jobs' };
  table.transaction = async (cb) => cb(table);
  return table;
}

jest.mock('../../src/database/db', () => ({
  db: mockMakeDb(),
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/downloadZipService', () => ({
  cleanup: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
}));

const { deleteEventCascade } = require('../../src/routes/adminEvents/helpers');

describe('deleteEventCascade — storage cleanup', () => {
  beforeEach(() => {
    mockStorage.delete.mockClear();
    mockPhotoRowsDeleted = false;
    mockJobRowsDeleted = false;
    mockSharedDerivatives = [];
  });

  it('deletes originals and every derived tier from the storage backend', async () => {
    await deleteEventCascade(42, { id: 1, username: 'admin' });

    const deleted = mockStorage.delete.mock.calls.map(([key]) => key);

    expect(deleted).toEqual(expect.arrayContaining([
      'events/active/other-demo-2026-01-01/photo_one.jpg',
      'events/active/other-demo-2026-01-01/photo_two.jpg',
      'thumbnails/thumb_aaa_photo_one.jpg',
      'thumbnails/thumb_bbb_photo_two.jpg',
      'previews/prev_aaa_photo_one.jpg',
    ]));
  });

  it('deletes pre-generated watermarks and the archive zip', async () => {
    await deleteEventCascade(42, { id: 1, username: 'admin' });

    const deleted = mockStorage.delete.mock.calls.map(([key]) => key);

    // Both are storage-backend objects that only fs.unlink ever touched, so
    // both survived an event delete on S3.
    expect(deleted).toEqual(expect.arrayContaining([
      'watermarked/wm_aaa_photo_one.jpg',
      'archives/other-demo-2026-01-01.zip',
    ]));
  });

  it('deletes the download caches, which only fs.rm ever covered', async () => {
    await deleteEventCascade(42, { id: 1, username: 'admin' });

    const deleted = mockStorage.delete.mock.calls.map(([key]) => key);

    // Both sit under events/active/{slug}/.download-cache/ — swept by the
    // recursive fs.rm on local disk, invisible to it on S3 where the prefix
    // is not a directory. Both are gallery-sized.
    expect(deleted).toEqual(expect.arrayContaining([
      'events/active/other-demo-2026-01-01/.download-cache/all.zip',
      'events/active/other-demo-2026-01-01/.download-cache/job-abc123.zip',
    ]));
  });

  it('leaves a derivative alone when another event still points at it', async () => {
    // Canonical thumbnail/hero/preview keys are not event-scoped — the
    // basename is the photo's filename, and filenames are not unique across
    // events. Deleting one a surviving gallery still references would blank
    // its tile.
    mockSharedDerivatives = [{
      thumbnail_path: 'thumbnails/thumb_aaa_photo_one.jpg',
      hero_path: null,
      preview_path: null,
      watermark_path: null,
    }];

    await deleteEventCascade(42, { id: 1, username: 'admin' });

    const deleted = mockStorage.delete.mock.calls.map(([key]) => key);
    expect(deleted).not.toContain('thumbnails/thumb_aaa_photo_one.jpg');
    // The originals are slug-scoped and must still go.
    expect(deleted).toContain('events/active/other-demo-2026-01-01/photo_one.jpg');
    // So must a derivative nobody else claims.
    expect(deleted).toContain('thumbnails/thumb_bbb_photo_two.jpg');
  });

  it('cancels an in-flight Download All build before snapshotting paths', async () => {
    const downloadZipService = require('../../src/services/downloadZipService');
    await deleteEventCascade(42, { id: 1, username: 'admin' });

    // Otherwise a builder mid-flight uploads its zip after the sweep and
    // writes the path onto a row that no longer exists.
    expect(downloadZipService.cleanup).toHaveBeenCalledWith(42);
  });

  it('never asks the backend to delete the same key twice', async () => {
    await deleteEventCascade(42, { id: 1, username: 'admin' });

    const managed = mockStorage.delete.mock.calls
      .map(([key]) => key)
      .filter((key) => !key.startsWith('thumbnails/thumb_w') && !key.startsWith('previews/preview_w'));

    expect(managed).toEqual([...new Set(managed)]);
  });

  it('leaves external/reference photos in place', async () => {
    await deleteEventCascade(42, { id: 1, username: 'admin' });

    const deleted = mockStorage.delete.mock.calls.map(([key]) => key);
    expect(deleted).not.toEqual(expect.arrayContaining(['ignored.jpg']));
    expect(deleted).not.toEqual(expect.arrayContaining(['events/active/ignored.jpg']));
  });

  it('still completes the delete when the storage backend throws', async () => {
    mockStorage.delete.mockRejectedValue(new Error('bucket unreachable'));

    await expect(deleteEventCascade(42, { id: 1, username: 'admin' }))
      .resolves.toEqual({ id: 42, name: 'Demo' });

    mockStorage.delete.mockResolvedValue(undefined);
  });
});
