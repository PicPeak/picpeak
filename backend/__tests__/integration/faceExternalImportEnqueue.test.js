/**
 * External imports are queued for face scanning (#1090).
 *
 * Managed uploads are enqueued by photoProcessor, which writes
 * face_status 'pending' once a photo is processed (photoProcessor.js:573 —
 * "the only correct place to enqueue"). External media never goes through
 * photoProcessor: adminExternalMedia inserts rows directly.
 *
 * Before #1090 that gap was invisible, because faceProcessor skipped every
 * external photo regardless. Once they became scannable, importing into an
 * already-enabled event still produced nothing until someone pressed Re-scan —
 * the second half of the reported bug, and the half that is easy to miss
 * because the first half looks like a complete fix.
 *
 * This asserts the insert itself, not the HTTP route: the route needs a real
 * mounted directory tree, and the contract worth pinning is "rows arrive
 * queued when the feature is on, and untouched when it is off".
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-extenq-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'extenq-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let faceSettings;

async function seedEvent({ facesEnabled }) {
  const [e] = await db('events').insert({
    slug: `extenq-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'wedding',
    event_name: 'extenq',
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `extenq-${Math.random()}`,
    expires_at: new Date().toISOString(),
    face_recognition_enabled: facesEnabled,
    source_mode: 'reference',
  }).returning('id');
  return typeof e === 'object' ? e.id : e;
}

/** Mirrors the insert adminExternalMedia performs per imported file. */
async function importOne(eventId, queueFaces) {
  const [p] = await db('photos').insert({
    event_id: eventId,
    filename: 'nas.jpg',
    path: 'slug/nas.jpg',
    thumbnail_path: null,
    type: 'individual',
    size_bytes: 1234,
    width: 4000,
    height: 3000,
    source_origin: 'external',
    external_relpath: 'nas/nas.jpg',
    face_status: queueFaces ? 'pending' : null,
  }).returning('id');
  return typeof p === 'object' ? p.id : p;
}

describe('external import queues faces (#1090)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    faceSettings = require('../../src/services/faceSettings');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function setFeatureFlag(on) {
    await db('feature_flags').insert({ key: 'faces', value: on })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: on }); });
    // The flag read is TTL-cached (requireFeatureFlag.js:26-34); production
    // invalidates after every write, and so must this or the second flip in
    // this suite reads a stale `true`.
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  }

  it('marks imported photos pending when detection is on for the event', async () => {
    await setFeatureFlag(true);
    const eventId = await seedEvent({ facesEnabled: true });
    const event = await db('events').where({ id: eventId }).first();

    const queueFaces = await faceSettings.isEnabledForEvent(event);
    expect(queueFaces).toBe(true);

    const photoId = await importOne(eventId, queueFaces);

    // 'pending' specifically: faceQueue.claimNextPhoto only claims that value
    // (faceQueue.js:64), so NULL here means the photo waits for a manual
    // Re-scan — which is the bug.
    const photo = await db('photos').where({ id: photoId }).first();
    expect(photo.face_status).toBe('pending');
  });

  it('leaves face_status untouched when the per-event toggle is off', async () => {
    await setFeatureFlag(true);
    const eventId = await seedEvent({ facesEnabled: false });
    const event = await db('events').where({ id: eventId }).first();

    const queueFaces = await faceSettings.isEnabledForEvent(event);
    expect(queueFaces).toBe(false);

    const photo = await db('photos').where({ id: await importOne(eventId, queueFaces) }).first();
    expect(photo.face_status).toBeNull();
  });

  it('leaves face_status untouched when the global flag is off', async () => {
    // Installs without the feature must never accumulate face_status rows —
    // the same invariant photoProcessor's guard protects.
    await setFeatureFlag(false);
    const eventId = await seedEvent({ facesEnabled: true });
    const event = await db('events').where({ id: eventId }).first();

    const queueFaces = await faceSettings.isEnabledForEvent(event);
    expect(queueFaces).toBe(false);

    const photo = await db('photos').where({ id: await importOne(eventId, queueFaces) }).first();
    expect(photo.face_status).toBeNull();
  });
});
