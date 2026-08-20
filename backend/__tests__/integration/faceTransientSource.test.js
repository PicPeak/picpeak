/**
 * A dropped mount defers a scan; a dead photo fails it.
 *
 * ensurePreviewImage returns null for both "this JPEG is corrupt" and "the
 * NFS share is gone", and #1090 made that distinction matter: external
 * libraries now reach this path, and network mounts drop far more often than
 * local disks. Failing on an outage strands the photo — faceQueue only ever
 * claims 'pending', and nothing re-queues a failure automatically, so a mount
 * that blinked mid-scan would cost an entire gallery a manual Re-scan.
 *
 * The probe checks the containing DIRECTORY rather than the file, because that
 * is what separates the two cases: a missing file inside a healthy directory
 * is a broken photo, an unreachable directory is broken storage.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-transient-'));
process.env.TEST_DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'transient-test-secret';
// Created BEFORE anything requires externalMediaService: getExternalMediaRoot
// only honours the env var if the directory already exists, and caches the
// result on first call — set it later and every path silently resolves
// against a fallback root instead.
process.env.EXTERNAL_MEDIA_ROOT = path.join(tmpRoot, 'media');
fs.mkdirSync(process.env.EXTERNAL_MEDIA_ROOT, { recursive: true });

let previewKeyResult = null;
const mockEnsurePreviewImage = jest.fn(async () => previewKeyResult);

jest.mock('../../src/services/imageProcessor', () => ({
  ...jest.requireActual('../../src/services/imageProcessor'),
  ensurePreviewImage: (...args) => mockEnsurePreviewImage(...args),
}));

jest.mock('../../src/services/faceClient', () => ({
  detectFaces: jest.fn(async () => ({ model_version: 'test-v1', faces: [] })),
  SidecarUnavailableError: class extends Error {},
}));

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let faceProcessor;

async function seedExternalPhoto({ externalPath, relpath = 'individual/a.jpg' }) {
  const [e] = await db('events').insert({
    slug: `tr-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'wedding',
    event_name: 'tr',
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `tr-${Math.random()}`,
    expires_at: new Date().toISOString(),
    face_recognition_enabled: true,
    source_mode: 'reference',
    external_path: externalPath,
  }).returning('id');
  const eventId = typeof e === 'object' ? e.id : e;

  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: 'a.jpg',
    path: 'tr/a.jpg',
    type: 'individual',
    width: 4000,
    height: 3000,
    processing_status: 'complete',
    face_status: 'processing',
    source_origin: 'external',
    external_relpath: relpath,
  }).returning('id');
  return { eventId, photoId: typeof p === 'object' ? p.id : p };
}

describe('transient source vs dead photo', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await db('feature_flags').insert({ key: 'faces', value: true })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: true }); });
    faceProcessor = require('../../src/services/faceProcessor');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    previewKeyResult = null; // i.e. ensurePreviewImage could not build one
    mockEnsurePreviewImage.mockClear();
  });

  it('defers, not fails, when the source directory is unreachable', async () => {
    // Nothing was ever created under EXTERNAL_MEDIA_ROOT for this path, so the
    // directory does not resolve — the shape a dropped mount presents.
    const { photoId } = await seedExternalPhoto({ externalPath: 'vanished-share' });

    await expect(faceProcessor.processPhotoFaces(photoId))
      .rejects.toBeInstanceOf(faceProcessor.TransientSourceError);

    // Critically: still claimable. A 'failed' here is what stranded the photo.
    const photo = await db('photos').where({ id: photoId }).first();
    expect(photo.face_status).not.toBe('failed');
  });

  it('defers when the event root survives an unmount but is empty', async () => {
    // The common NFS/SMB shape: unmounting leaves the mountpoint behind as an
    // ordinary empty directory, so fs.access succeeds on storage that is
    // entirely gone. The EVENT ROOT is the thing that goes empty — the photo's
    // own subdirectory vanishes with it.
    const emptyRoot = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'unmounted');
    await fs.promises.mkdir(emptyRoot, { recursive: true });
    const { photoId } = await seedExternalPhoto({ externalPath: 'unmounted' });

    await expect(faceProcessor.processPhotoFaces(photoId))
      .rejects.toBeInstanceOf(faceProcessor.TransientSourceError);

    const photo = await db('photos').where({ id: photoId }).first();
    expect(photo.face_status).not.toBe('failed');
  });

  it('fails when the directory is healthy but the file is gone', async () => {
    // Directory exists, file does not — a genuinely broken photo, which should
    // surface as a failure the admin can see rather than retry forever.
    const live = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'live-share', 'individual');
    await fs.promises.mkdir(live, { recursive: true });
    // Non-empty: an empty directory is now read as an unmounted share, so the
    // "healthy storage, dead photo" case needs a sibling file present.
    await fs.promises.writeFile(path.join(live, 'sibling.jpg'), 'x');
    const { photoId } = await seedExternalPhoto({ externalPath: 'live-share' });

    const result = await faceProcessor.processPhotoFaces(photoId);

    expect(result.status).toBe('failed');
    const photo = await db('photos').where({ id: photoId }).first();
    expect(photo.face_status).toBe('failed');
    expect(photo.face_error).toMatch(/preview/i);
  });

  it('fails a missing subdirectory rather than deferring the whole event', async () => {
    // individual/ deleted while collages/ is fine. Probing only the photo's own
    // directory reports ENOENT and would read as a mount-wide outage, deferring
    // the event and starving every healthy sibling folder. The root is
    // populated, so the mount is up and this is a broken path.
    const root = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'partial');
    await fs.promises.mkdir(path.join(root, 'collages'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'collages', 'kept.jpg'), 'x');
    const { photoId } = await seedExternalPhoto({ externalPath: 'partial' });

    const result = await faceProcessor.processPhotoFaces(photoId);
    expect(result.status).toBe('failed');
  });

  it('defers a file that exists but cannot be read', async () => {
    // EACCES / EIO / ESTALE on the file itself, with the mount up: a transient
    // condition wearing a per-file disguise. Only ENOENT means genuinely gone.
    const root = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'locked');
    const dir = path.join(root, 'individual');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'a.jpg');
    await fs.promises.writeFile(file, 'x');
    await fs.promises.chmod(file, 0o000);

    const { photoId } = await seedExternalPhoto({ externalPath: 'locked' });
    try {
      await expect(faceProcessor.processPhotoFaces(photoId))
        .rejects.toBeInstanceOf(faceProcessor.TransientSourceError);
    } finally {
      await fs.promises.chmod(file, 0o644).catch(() => {});
    }
  });

  it('still fails managed photos without probing the mount', async () => {
    // The probe is scoped to external/reference rows: a managed photo with no
    // preview is broken, and there is no mount to blame.
    const [e] = await db('events').insert({
      slug: `tr-m-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'trm',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `tr-m-${Math.random()}`,
      expires_at: new Date().toISOString(),
      face_recognition_enabled: true,
    }).returning('id');
    const [p] = await db('photos').insert({
      event_id: typeof e === 'object' ? e.id : e,
      filename: 'm.jpg',
      path: 'trm/m.jpg',
      type: 'individual',
      width: 100,
      height: 100,
      processing_status: 'complete',
      face_status: 'processing',
      source_origin: 'managed',
    }).returning('id');

    const result = await faceProcessor.processPhotoFaces(typeof p === 'object' ? p.id : p);
    expect(result.status).toBe('failed');
  });
});
