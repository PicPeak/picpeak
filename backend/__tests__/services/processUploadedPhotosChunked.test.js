/**
 * processUploadedPhotos, the chunked admin upload's processing step.
 *
 *  - issue 1980: no database transaction is open while the media work runs.
 *    On SQLite the pool is one connection, so a transaction held through the
 *    thumbnail blocked every other query until the 60 s acquire timeout.
 *  - issue 1976: the row gets its EXIF capture date. This path completes the
 *    row itself, so the worker that reads it for a batch upload never runs.
 */
const mockProbe = { run: null };
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    generateThumbnail: async (...args) => {
      if (mockProbe.run) await mockProbe.run();
      return actual.generateThumbnail(...args);
    },
  };
});

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('processUploadedPhotos (chunked admin upload)', () => {
  let db; let cleanup; let processUploadedPhotos; let counter = 0;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ processUploadedPhotos } = require('../../src/services/photoProcessor'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function makeEvent() {
    counter += 1;
    const slug = `chunked-test-${counter}`;
    const inserted = await db('events').insert({
      slug, event_type: 'wedding', event_name: `Chunked Test ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `chunked-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    return db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
  }

  async function upload(event, name, bytes) {
    const temp = path.join(process.env.STORAGE_PATH, `upload-${name}`);
    await fs.promises.writeFile(temp, bytes);
    return processUploadedPhotos(
      [{ path: temp, originalname: name, mimetype: 'image/jpeg', size: bytes.length }], event.id
    );
  }

  const jpeg = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#808080' } }).jpeg();

  it('leaves the database free for other queries while it makes the thumbnail (issue 1980)', async () => {
    const event = await makeEvent();
    let probe = null;
    mockProbe.run = async () => {
      probe = await Promise.race([
        db.raw('select 1').then(() => 'answered'),
        new Promise(resolve => setTimeout(() => resolve('blocked'), 3000)),
      ]);
    };
    let uploaded;
    try {
      uploaded = await upload(event, 'probe.jpg', await jpeg().toBuffer());
    } finally {
      mockProbe.run = null;
    }
    expect(probe).toBe('answered');
    expect(uploaded).toHaveLength(1);
    const row = await db('photos').where({ id: uploaded[0].id }).first();
    expect(row).toMatchObject({ event_id: event.id, original_filename: 'probe.jpg' });
  }, 30000);

  it('stores the EXIF capture date, and none for a file without one (issue 1976)', async () => {
    const event = await makeEvent();
    const dated = await jpeg().withExif({ IFD2: { DateTimeOriginal: '2021:06:15 14:30:00' } }).toBuffer();
    const [withDate] = await upload(event, 'dated.jpg', dated);
    const [withoutDate] = await upload(event, 'undated.jpg', await jpeg().toBuffer());

    const row = await db('photos').where({ id: withDate.id }).first();
    // exifr reads the EXIF wall-clock time as local time, like the worker does.
    expect(new Date(row.captured_at).getTime()).toBe(new Date(2021, 5, 15, 14, 30, 0).getTime());
    expect((await db('photos').where({ id: withoutDate.id }).first()).captured_at).toBeNull();
  }, 30000);
});
