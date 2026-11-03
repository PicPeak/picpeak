/**
 * A ZIP never holds two entries of the same name.
 *
 * getZipEntryNames makes the stored names unique, but a capped AVIF, HEIC or
 * RAW ships as a JPEG and takes the `.jpg` extension afterwards: next to a
 * JPEG of the same stem both entries were named `IMG_1.jpg`, and extracting
 * the archive kept only one of them.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// Entry names from the ZIP's central directory.
function zipEntryNames(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const collect = (res, cb) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('ZIP entry names after a format conversion', () => {
  let db;
  let cleanup;
  let app;
  let event;
  let photoIds;
  let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const slug = 'zip-names-test';
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: 'Zip Names',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: 'zip-names-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      download_standard_resolution: '800x600',
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];

    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    const image = sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 80, b: 40 } } });
    const files = [
      { filename: 'IMG_1.avif', mime: 'image/avif', bytes: await image.clone().avif().toBuffer() },
      { filename: 'IMG_1.jpg', mime: 'image/jpeg', bytes: await image.clone().jpeg().toBuffer() },
    ];
    photoIds = [];
    for (const [i, file] of files.entries()) {
      await fs.promises.writeFile(path.join(dir, file.filename), file.bytes);
      const p = await db('photos').insert({
        event_id: id,
        filename: file.filename,
        path: `${slug}/${file.filename}`,
        type: 'individual',
        media_type: 'image',
        mime_type: file.mime,
        size_bytes: file.bytes.length,
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }
    event = await db('events').where({ id }).first();
    token = jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  const expectDistinctJpegs = (names) => {
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name.endsWith('.jpg'))).toBe(true);
  };

  it('download-selected', async () => {
    const res = await request(app)
      .post(`/api/gallery/${event.slug}/download-selected`)
      .set('Authorization', `Bearer ${token}`)
      .send({ photo_ids: photoIds })
      .buffer(true).parse(collect);
    expect(res.status).toBe(200);
    expectDistinctJpegs(zipEntryNames(res.body));
  });

  it('download-all', async () => {
    const res = await request(app)
      .get(`/api/gallery/${event.slug}/download-all`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true).parse(collect);
    expect(res.status).toBe(200);
    expectDistinctJpegs(zipEntryNames(res.body));
  });
});
