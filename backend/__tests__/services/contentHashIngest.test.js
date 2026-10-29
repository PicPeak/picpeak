/**
 * The watch folder and the S3 auto-import store the content hash of what
 * they bring in (issue 2194), the way the upload paths do, so the
 * duplicate check on upload matches those photos too and the backfill gap
 * does not reopen.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { bootCrmDb } = require('../integration/helpers/crmDb');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('content hash on watch-folder and S3 ingest (issue 2194)', () => {
  let db; let cleanup; let counter = 0;
  let processNewPhoto; let processEvent;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ processNewPhoto } = require('../../src/services/fileWatcher'));
    ({ processEvent } = require('../../src/services/s3AutoImporter').__test);
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function makeEvent() {
    counter += 1;
    const slug = `ingest-hash-${counter}`;
    const inserted = await db('events').insert({
      slug, event_type: 'wedding', event_name: `Ingest Hash ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `ingest-hash-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    return db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
  }

  const jpeg = () => sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 90, g: 30, b: 160 } } }).jpeg().toBuffer();

  it('the watcher stores the hash of a file dropped into the folder', async () => {
    const event = await makeEvent();
    const dir = path.join(process.env.STORAGE_PATH, 'events/active', event.slug, 'individual');
    await fs.promises.mkdir(dir, { recursive: true });
    const bytes = await jpeg();
    const filePath = path.join(dir, 'IMG_0001.jpg');
    await fs.promises.writeFile(filePath, bytes);

    await processNewPhoto(filePath);

    const photo = await db('photos').where({ event_id: event.id }).first();
    expect(photo.content_sha256).toBe(sha(bytes));
  });

  async function importFromBucket(event, name, bytes) {
    const key = `events/active/${event.slug}/${name}`;
    const full = path.join(process.env.STORAGE_PATH, key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, bytes);
    const bucket = {
      list: async () => [{ key, size: bytes.length }],
      get: jest.fn(async (k) => fs.createReadStream(path.join(process.env.STORAGE_PATH, k))),
    };
    // A key is imported on the second poll that lists it.
    await processEvent(event, bucket);
    await processEvent(event, bucket);
    return { photo: await db('photos').where({ event_id: event.id }).first(), bucket };
  }

  it('the S3 auto-import stores the hash of an image', async () => {
    const event = await makeEvent();
    const bytes = await jpeg();
    const { photo } = await importFromBucket(event, 'shot.jpg', bytes);
    expect(photo.content_sha256).toBe(sha(bytes));
  });

  it('the S3 auto-import leaves a video to the backfill instead of downloading it twice', async () => {
    const event = await makeEvent();
    const bytes = Buffer.from('not a real mp4, never read for its hash');
    const { photo, bucket } = await importFromBucket(event, 'clip.mp4', bytes);
    expect(photo.media_type).toBe('video');
    expect(photo.content_sha256).toBeNull();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('the watcher leaves a video to the backfill', async () => {
    const event = await makeEvent();
    const dir = path.join(process.env.STORAGE_PATH, 'events/active', event.slug, 'individual');
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'CLIP_0001.mp4');
    await fs.promises.writeFile(filePath, Buffer.from('not a real mp4'));

    await processNewPhoto(filePath);

    const photo = await db('photos').where({ event_id: event.id }).first();
    expect(photo).toMatchObject({ media_type: 'video', content_sha256: null });
  });
});
