/**
 * A .picpeak archive made before download limits existed (issue 1560) has no
 * event_download_grants table. Restoring it must still clear the local
 * grants: they point at photo ids the restore reuses for other photos.
 */
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db; let cleanup; let adminId; let tmpDir; let createPicpeak; let importFromPicpeak;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
}, 120000);
afterAll(async () => { if (cleanup) await cleanup(); });

it('clears local grants when the archive predates them', async () => {
  const [event] = await db('events').insert({
    slug: 'restore-grants', event_type: 'wedding', event_name: 'Restore grants', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: '/gallery/restore-grants/share', share_token: 'restore-grants-share',
    expires_at: new Date(Date.now() + 86400000).toISOString(), download_limit: 1,
    created_at: new Date().toISOString(),
  }).returning('id');
  const eventId = event?.id ?? event;
  const [photo] = await db('photos').insert({
    event_id: eventId, filename: 'a.jpg', path: 'restore-grants/a.jpg', type: 'individual',
    uploaded_at: new Date().toISOString(),
  }).returning('id');
  const photoId = photo?.id ?? photo;

  await db.schema.dropTable('event_download_grants');
  const { filePath, manifest } = await createPicpeak({ includeFiles: false, outDir: `${tmpDir}/archives` });
  expect(Object.hasOwn(manifest.tables, 'event_download_grants')).toBe(false);
  await require('../../migrations/core/231_event_download_limit').up(db);
  await db('event_download_grants').insert({
    event_id: eventId, photo_id: photoId, granted_at: new Date().toISOString(),
  });

  expect((await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId })).restored).toBe(true);
  const { c } = await db('event_download_grants').count('id as c').first();
  expect(Number(c)).toBe(0);
});
