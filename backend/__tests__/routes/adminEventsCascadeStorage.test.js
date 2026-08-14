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
};
const mockPhotos = [
  {
    id: 1,
    path: 'other-demo-2026-01-01/photo_one.jpg',
    thumbnail_path: 'thumbnails/thumb_aaa_photo_one.jpg',
    hero_path: null,
    preview_path: 'previews/prev_aaa_photo_one.jpg',
    source_origin: 'managed',
  },
  {
    id: 2,
    path: 'other-demo-2026-01-01/photo_two.jpg',
    thumbnail_path: 'thumbnails/thumb_bbb_photo_two.jpg',
    hero_path: null,
    preview_path: null,
    source_origin: 'managed',
  },
  {
    // External photos live outside the managed backend and must be left alone.
    id: 3,
    path: 'ignored.jpg',
    thumbnail_path: null,
    hero_path: null,
    preview_path: null,
    source_origin: 'external',
  },
];

let mockPhotoRowsDeleted = false;

function mockMakeDb() {
  const table = (name) => {
    const chain = {
      where: () => chain,
      first: async () => (name === 'events' ? mockEvent : undefined),
      select: async () => {
        if (name === 'photos') {
          // The whole point: if this runs after the transaction, the rows
          // are gone and we would collect nothing.
          return mockPhotoRowsDeleted ? [] : mockPhotos;
        }
        return [];
      },
      del: async () => {
        if (name === 'photos') mockPhotoRowsDeleted = true;
        return 1;
      },
    };
    return chain;
  };
  // #1132 guards the merge-dismissals delete behind a hasTable check.
  table.schema = { hasTable: async () => false };
  table.transaction = async (cb) => cb(table);
  return table;
}

jest.mock('../../src/database/db', () => ({
  db: mockMakeDb(),
  logActivity: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
}));

const { deleteEventCascade } = require('../../src/routes/adminEvents/helpers');

describe('deleteEventCascade — storage cleanup', () => {
  beforeEach(() => {
    mockStorage.delete.mockClear();
    mockPhotoRowsDeleted = false;
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
