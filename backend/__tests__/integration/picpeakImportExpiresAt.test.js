/**
 * A .picpeak import canonicalises the events.expires_at text it brings back
 * (issue 1733), the way it already normalises the email queue.
 *
 * Archived rows are batch-inserted as they were, and migration 238 does not
 * run again on a target that already recorded it; without the hook an
 * expiry stored as `…+0200` by an older install would come back unreadable
 * to julianday() and fall out of every expiry comparison.
 */
// (Not forced here: process.env.TZ does not re-bind inside a running jest
// process. The non-UTC server zone is proven in a child process in
// __tests__/utils/expiresAtText.test.js; these cases hold in every zone.)

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db; let cleanup; let tmpDir; let backupFile;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  const { adminId } = await seedMinimal(db);
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { importFromPicpeak } = require('../../src/services/picpeakImportService');

  const base = {
    event_type: 'wedding', host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: new Date().toISOString(),
  };
  await db('events').insert([
    { ...base, slug: 'offset', event_name: 'offset', share_token: 't-offset', share_link: '/gallery/offset/t-offset', expires_at: '2026-10-06T12:00:00+0200' },
    { ...base, slug: 'iso', event_name: 'iso', share_token: 't-iso', share_link: '/gallery/iso/t-iso', expires_at: '2026-10-06T12:00:00.000Z' },
    { ...base, slug: 'zoneless', event_name: 'zoneless', share_token: 't-zl', share_link: '/gallery/zoneless/t-zl', expires_at: '2026-10-06 12:00:00' },
    { ...base, slug: 'landmine', event_name: 'landmine', share_token: 't-lm', share_link: '/gallery/landmine/t-lm', expires_at: '[object Object]' },
  ]);
  ({ filePath: backupFile } = await createPicpeak({ includePhotos: false }));
  await db('events').del();
  await importFromPicpeak({ picpeakPath: backupFile, currentAdminId: adminId });
}, 120000);

afterAll(async () => {
  if (backupFile) fs.rmSync(path.dirname(backupFile), { recursive: true, force: true });
  await cleanup();
});

test('the imported rows carry an expires_at julianday() can read', async () => {
  const rows = await db('events').whereIn('slug', ['offset', 'iso', 'zoneless', 'landmine']).select('slug', 'expires_at');
  const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.expires_at]));
  expect(bySlug.offset).toBe('2026-10-06T10:00:00.000Z');
  expect(bySlug.iso).toBe('2026-10-06T12:00:00.000Z');
  // Zone-less text is stamped as the UTC instant SQLite reads it as.
  expect(bySlug.zoneless).toBe('2026-10-06T12:00:00.000Z');
  // Unreadable before, unreadable after: left as archived.
  expect(bySlug.landmine).toBe('[object Object]');
});
