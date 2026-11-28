/**
 * ZIP entries carry the shot time (issue 2617).
 *
 * Every entry used to carry the moment the archive was built, so an unpacked
 * gallery sorted by nothing in a file manager. A ZIP entry's time has no zone
 * and unzip tools show it as it is, so it is the wall clock the camera showed:
 * captured_at_wall, else captured_at in the server's zone, else the upload
 * time in that zone. Read straight from the central directory, so the zone
 * jest runs in plays no part.
 */
const crypto = require('crypto');
const path = require('path');
const { PassThrough } = require('stream');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// Entry name -> DOS date/time as 'YYYY-MM-DDTHH:MM:SS', from the central directory.
function zipEntryTimes(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const pad = (n) => String(n).padStart(2, '0');
  const times = {};
  for (let i = 0; i < count; i += 1) {
    const time = buffer.readUInt16LE(offset + 12);
    const date = buffer.readUInt16LE(offset + 14);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    times[name] = `${(date >> 9) + 1980}-${pad((date >> 5) & 0x0f)}-${pad(date & 0x1f)}`
      + `T${pad(time >> 11)}:${pad((time >> 5) & 0x3f)}:${pad((time & 0x1f) * 2)}`;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return times;
}

const collect = (res, cb) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// An instant as the wall clock it shows in this process's zone.
const serverWall = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// Even seconds: a ZIP time has a resolution of two.
const PHOTOS = [
  // The camera clock as written wins over the instant (here an hour apart,
  // as after a server TZ change), and its recorded offset is dropped.
  { filename: 'camera.jpg', captured_at: '2025-06-01T06:45:04.000Z', captured_at_wall: '2025-06-01T09:45:04+02:00', uploaded_at: '2026-01-01T10:00:00.000Z' },
  { filename: 'instant.jpg', captured_at: '2024-12-24T17:00:10.000Z', captured_at_wall: '', uploaded_at: '2026-01-01T10:00:00.000Z' },
  { filename: 'upload.jpg', captured_at: null, captured_at_wall: null, uploaded_at: '2023-03-04T05:06:08.000Z' },
];
const EXPECTED = {
  'camera.jpg': '2025-06-01T09:45:04',
  'instant.jpg': serverWall('2024-12-24T17:00:10.000Z'),
  'upload.jpg': serverWall('2023-03-04T05:06:08.000Z'),
};

describe('ZIP entry dates (issue 2617)', () => {
  let db; let cleanup; let app; let storage;
  let sequence = 0;
  const idOf = (rows) => rows[0]?.id ?? rows[0];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    storage = require('../../src/services/storage').getStorage();
    app = express();
    app.use(express.json());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    await Promise.all(require('../../src/services/downloadJobService').liveBuilds.values());
    await require('../../src/services/downloadZipService').stop();
    if (cleanup) await cleanup();
  });

  // resolution: 'original' streams the stored bytes, a box renders a copy.
  async function fixture(resolution) {
    const slug = `zip-dates-${++sequence}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: crypto.randomBytes(24).toString('hex'),
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_downloads: 1,
      download_standard_resolution: resolution, download_resolution_picker_enabled: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
    const image = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#689abc' } }).jpeg().toBuffer();
    const ids = [];
    for (const photo of PHOTOS) {
      const key = `events/active/${slug}/individual/${photo.filename}`;
      await storage.put(key, image);
      ids.push(idOf(await db('photos').insert({
        event_id: id, path: key, type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
        size_bytes: image.length, source_origin: 'managed', ...photo,
      }).returning('id')));
    }
    const event = await db('events').where({ id }).first();
    const token = jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    return { event, ids, token };
  }

  describe.each(['original', '800x600'])('at resolution %s', (resolution) => {
    it('download-all', async () => {
      const { event, token } = await fixture(resolution);
      const res = await request(app).get(`/api/gallery/${event.slug}/download-all`)
        .set('Authorization', `Bearer ${token}`).buffer(true).parse(collect);
      expect(res.status).toBe(200);
      expect(zipEntryTimes(res.body)).toEqual(EXPECTED);
    });

    it('download-selected', async () => {
      const { event, ids, token } = await fixture(resolution);
      const res = await request(app).post(`/api/gallery/${event.slug}/download-selected`)
        .set('Authorization', `Bearer ${token}`).send({ photo_ids: ids }).buffer(true).parse(collect);
      expect(res.status).toBe(200);
      expect(zipEntryTimes(res.body)).toEqual(EXPECTED);
    });

    it('the prebuilt download-all archive', async () => {
      const { event } = await fixture(resolution);
      const downloadZipService = require('../../src/services/downloadZipService');
      const built = await downloadZipService.generateZip(event.id);
      expect(built.success).toBe(true);
      const zip = await new Promise((resolve, reject) => {
        storage.get(built.key).then((stream) => {
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        }, reject);
      });
      expect(zipEntryTimes(zip)).toEqual(EXPECTED);
    });

    it('a background download job', async () => {
      const { event, ids, token } = await fixture(resolution);
      const jobs = require('../../src/services/downloadJobService');
      const created = await request(app).post(`/api/gallery/${event.slug}/download-jobs`)
        .set('Authorization', `Bearer ${token}`).send({ photo_ids: ids });
      expect(created.status).toBe(202);
      const job = await jobs.getStatus(created.body.token);
      await jobs.liveBuilds.get(job.id);
      const ready = await jobs.getStatus(job.token);
      expect(ready.status).toBe('ready');
      const zip = await require('fs').promises.readFile(path.join(process.env.STORAGE_PATH, ready.zip_path));
      expect(zipEntryTimes(zip)).toEqual(EXPECTED);
    });
  });

  it('a transfer archive', async () => {
    const { ids } = await fixture('original');
    const now = new Date().toISOString();
    const transferId = idOf(await db('transfers').insert({
      token: crypto.randomBytes(32).toString('hex'), title: 'dates',
      expires_at: new Date(Date.now() + 864e5).toISOString(), download_count: 0,
      is_active: 1, grace_days: 7, allow_uploads: 0, delivery_method: 'link',
      created_at: now, updated_at: now,
    }).returning('id'));
    await db('transfer_files').insert(ids.map((photoId, i) => ({ transfer_id: transferId, photo_id: photoId, sort_order: i })));

    const res = new PassThrough();
    res.setHeader = () => {};
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    const ended = new Promise((resolve) => res.on('end', resolve));
    const { streamTransferArchive } = require('../../src/services/transferService');
    expect(await streamTransferArchive({ id: transferId, title: 'dates' }, res)).toBe(3);
    await ended;
    expect(zipEntryTimes(Buffer.concat(chunks))).toEqual(EXPECTED);
  });
});
