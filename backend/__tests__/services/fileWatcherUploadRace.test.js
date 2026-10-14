/**
 * The watched folder must not import a file an upload is still promoting
 * (issue 1970).
 *
 * Every upload path stores the file under events/active/ before its row
 * exists. A watcher run in that gap found no row and inserted its own: a
 * public row next to the upload's held-for-review one, so the gallery showed
 * the photo twice and published it without review.
 *
 * The race is driven for real: the storage backend's putFromFile hands the
 * stored file to the watcher before the upload goes on to insert its row.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-watcher-race-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'watcher-race-test-secret';
process.env.STORAGE_BACKEND = 'local';

const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const EVENT_SLUG = 'watcher-race-event';
// Long enough for an unguarded watcher run to finish its insert.
const WATCHER_HEAD_START_MS = 1500;

let db;
let cleanup;
let tmpDir;
let eventId;
let storage;
let processor;
let processNewPhoto;
let claimPromotion;
let jpeg;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventDir = () => path.join(process.env.STORAGE_PATH, 'events/active', EVENT_SLUG);

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: EVENT_SLUG,
    event_type: 'wedding',
    event_name: 'Watcher Race',
    event_date: '2026-10-14',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${EVENT_SLUG}/share`,
    share_token: 'watcher-race-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    allow_user_uploads: 1,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];
  fs.mkdirSync(eventDir(), { recursive: true });

  const LocalFs = require('../../src/services/storage/LocalFsStorage');
  storage = new LocalFs({ root: process.env.STORAGE_PATH });
  await storage.init();
  require('../../src/services/storage').setStorageForTesting(storage);
  processor = require('../../src/services/photoProcessor');
  ({ processNewPhoto } = require('../../src/services/fileWatcher'));
  ({ claimPromotion } = require('../../src/services/watchFolderClaims'));
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'white' } }).jpeg().toBuffer();
}, 120000);

afterEach(async () => {
  await db('photos').where({ event_id: eventId }).del();
  delete storage.putFromFile;
});

afterAll(async () => {
  await require('../../src/services/isolatedSharp').shutdown();
  require('../../src/services/storage').resetStorage();
  if (cleanup) await cleanup();
});

describe('fileWatcher vs. an upload in flight (issue 1970)', () => {
  it('leaves a held guest upload to its own row when the watcher fires before the insert', async () => {
    let watcherRun = null;
    const realPut = storage.putFromFile.bind(storage);
    storage.putFromFile = async (key, localPath, options) => {
      await realPut(key, localPath, options);
      // chokidar announces the stored file while the upload has not written
      // its row yet.
      watcherRun = processNewPhoto(path.join(process.env.STORAGE_PATH, key));
      await Promise.race([watcherRun, delay(WATCHER_HEAD_START_MS)]);
    };

    const temp = path.join(tmpDir, 'guest.jpg');
    fs.writeFileSync(temp, jpeg);
    const result = await processor.queueFilesForProcessing(
      [{ path: temp, originalname: 'guest.jpg', mimetype: 'image/jpeg' }],
      { eventId, uploadedBy: 'guest', heldForReview: true },
    );
    expect(result.errors).toEqual([]);
    expect(watcherRun).not.toBeNull();
    await watcherRun;

    const rows = await db('photos').where({ event_id: eventId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visibility: 'hidden', moderation_status: 'pending', uploaded_by: 'guest' });
  });

  it('still imports a file dropped in by hand', async () => {
    const filePath = path.join(eventDir(), 'IMG_0001.jpg');
    fs.writeFileSync(filePath, jpeg);

    await processNewPhoto(filePath);

    const rows = await db('photos').where({ event_id: eventId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: 'IMG_0001.jpg', path: `${EVENT_SLUG}/IMG_0001.jpg` });
  });

  it('waits for a failed promotion and then skips the file it removed', async () => {
    const key = `events/active/${EVENT_SLUG}/failed_upload.jpg`;
    const filePath = path.join(process.env.STORAGE_PATH, key);
    const release = claimPromotion(key);
    fs.writeFileSync(filePath, jpeg);

    const watcherRun = processNewPhoto(filePath);
    let settled = false;
    watcherRun.then(() => { settled = true; }, () => { settled = true; });
    await delay(200);
    expect(settled).toBe(false);

    // The upload's failure cleanup removes the file, then releases the key.
    fs.unlinkSync(filePath);
    release();
    await expect(watcherRun).resolves.toBeUndefined();
    expect(await db('photos').where({ event_id: eventId })).toHaveLength(0);
  });

  it('imports what a failed promotion left behind, as before', async () => {
    const key = `events/active/${EVENT_SLUG}/left_behind.jpg`;
    const filePath = path.join(process.env.STORAGE_PATH, key);
    const release = claimPromotion(key);
    fs.writeFileSync(filePath, jpeg);

    const watcherRun = processNewPhoto(filePath);
    await delay(50);
    release();
    await watcherRun;

    expect(await db('photos').where({ event_id: eventId })).toHaveLength(1);
  });
});

// The other upload paths share the shape: the claim must be taken before
// the file is stored, or the watcher can still slip into the gap.
describe('every promotion into the watched folder claims its key first', () => {
  const src = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
  it.each([
    ['routes/adminPhotos.js', 'storage.putFromFile(finalKey, file.path'],
    ['routes/v1/events.js', 'storage.putFromFile(finalKey, tempPath'],
    ['services/photoProcessor.js', 'getStorage().putFromFile(finalKey, tempPath'],
    ['services/photoProcessor.js', 'storage.putFromFile(finalKey, tempPath, { contentType: file.mimetype })'],
    ['services/photoReplacementService.js', 'storage.putFromFile(finalKey, newFileTempPath'],
  ])('%s: %s', (file, putCall) => {
    const source = src(file);
    const at = source.indexOf(putCall);
    expect(at).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/releaseClaim = claimPromotion\(finalKey\);/);
  });
});
