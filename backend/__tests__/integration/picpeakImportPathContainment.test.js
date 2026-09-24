'use strict';

// A .picpeak archive is trusted data once it is in the database: readers join
// events.archive_path and photos.watermark_path onto the storage root, so a
// crafted archive carrying `../` in one of those columns would let a later
// read reach a file outside storage. The import refuses such an archive
// outright and leaves the current data untouched.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db;
let cleanup;
let createPicpeak;
let importFromPicpeak;
let adminId;
const eventId = 81001;
const photoId = 81002;

async function getMarker() {
  const row = await db('app_settings').where({ setting_key: 'containment_marker' }).first();
  return row ? JSON.parse(row.setting_value) : null;
}
async function setMarker(value) {
  await db('app_settings')
    .insert({ setting_key: 'containment_marker', setting_value: JSON.stringify(value), setting_type: 'string' })
    .onConflict('setting_key').merge();
}

// Export the current tables as a .picpeak, restore the rows to their clean
// shape, and hand back the archive path.
async function exportWith(poison) {
  await poison();
  const { filePath } = await createPicpeak({ includePhotos: false });
  await db('events').where({ id: eventId }).update({ archive_path: null });
  await db('photos').where({ id: photoId }).update({ watermark_path: null, path: 'containment/individual/fixture.jpg' });
  return filePath;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await db('events').insert({ id: eventId, slug: 'containment', event_type: 'wedding', event_name: 'Containment',
    event_date: '2026-01-01', host_email: 'h@example.test', admin_email: 'a@example.test', password_hash: 'unused',
    share_link: '/gallery/containment', created_by: adminId });
  await db('photos').insert({ id: photoId, event_id: eventId, filename: 'fixture.jpg',
    path: 'containment/individual/fixture.jpg', type: 'individual', mime_type: 'image/jpeg', size_bytes: 1 });
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
}, 120000);

afterAll(async () => {
  await cleanup();
});

describe('.picpeak import path containment', () => {
  it('refuses an archive whose events.archive_path climbs out of storage, and restores nothing', async () => {
    await setMarker('in_backup');
    const archive = await exportWith(() => db('events').where({ id: eventId }).update({ archive_path: '../../../etc/passwd' }));
    await setMarker('current');
    try {
      await expect(importFromPicpeak({ picpeakPath: archive, currentAdminId: adminId }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/events\.archive_path/) });
    } finally {
      fs.rmSync(path.dirname(archive), { recursive: true, force: true });
    }
    expect(await getMarker()).toBe('current');
    expect((await db('events').where({ id: eventId }).first()).archive_path).toBeNull();
  });

  it('refuses an archive whose photos.watermark_path climbs out of storage, whichever separator it uses', async () => {
    await setMarker('in_backup');
    const archive = await exportWith(() => db('photos').where({ id: photoId }).update({ watermark_path: 'watermarks\\..\\..\\outside\\secret.bin' }));
    await setMarker('current');
    try {
      await expect(importFromPicpeak({ picpeakPath: archive, currentAdminId: adminId }))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/photos\.watermark_path/) });
    } finally {
      fs.rmSync(path.dirname(archive), { recursive: true, force: true });
    }
    expect(await getMarker()).toBe('current');
  });

  it('restores an archive whose paths stay inside their roots', async () => {
    await setMarker('in_backup');
    const archive = await exportWith(() => db('events').where({ id: eventId }).update({ archive_path: 'events/archived/containment.zip' }));
    await setMarker('current');
    try {
      const result = await importFromPicpeak({ picpeakPath: archive, currentAdminId: adminId });
      expect(result.restored).toBe(true);
    } finally {
      fs.rmSync(path.dirname(archive), { recursive: true, force: true });
    }
    expect(await getMarker()).toBe('in_backup');
    expect((await db('events').where({ id: eventId }).first()).archive_path).toBe('events/archived/containment.zip');
  });
});
