/**
 * A portable archive made before migration 311 carries no rendition_version.
 * Its photos must come back as 0 (renditions may carry EXIF, issue 2096), not
 * with the column default 1, or the background refresh skips them for good.
 * An archive that has the column keeps its values.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The supervised restore worker is not what this pins; the row handling is.
jest.mock('../../src/services/portableRestoreWorker', () => ({
  ...jest.requireActual('../../src/services/portableRestoreWorker'),
  assertWorkerAuthority: jest.fn(async () => ({})),
}));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('portable import and rendition_version', () => {
  let db;
  let cleanup;
  let tmpDir;
  let eventId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-rv-import-'));
    const inserted = await db('events').insert({
      slug: 'rv-import', event_type: 'wedding', event_name: 'RV Import', event_date: '2026-08-01',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      share_link: '/gallery/rv-import/share', share_token: 'rv-import-share',
      expires_at: new Date(Date.now() + 86400000).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];
  }, 120000);

  afterAll(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (cleanup) await cleanup();
  });

  const photo = (id, extra = {}) => ({
    id, event_id: eventId, filename: `p${id}.jpg`, original_filename: `p${id}.jpg`, path: `rv-import/p${id}.jpg`,
    type: 'individual', media_type: 'image', mime_type: 'image/jpeg', processing_status: 'complete',
    thumbnail_path: `thumbnails/thumb_p${id}.jpg`, uploaded_at: new Date().toISOString(), ...extra,
  });

  async function importPhotos(rows) {
    const dataDir = path.join(tmpDir, `data-${rows[0].id}`);
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'photos.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { replaceAllTables } = require('../../src/services/picpeakImportService');
    await db.transaction((trx) => replaceAllTables(['photos'], dataDir, null, null, { executor: trx, allTables: ['photos'] }));
    return Array.from(await db('photos').orderBy('id').select('id', 'rendition_version'))
      .map((r) => [r.id, Number(r.rendition_version)]);
  }

  it('marks the photos of an archive without the column as needing a refresh', async () => {
    expect(await importPhotos([photo(101), photo(102)])).toEqual([[101, 0], [102, 0]]);
  });

  it('keeps the values of an archive that has the column', async () => {
    expect(await importPhotos([photo(201, { rendition_version: 1 }), photo(202, { rendition_version: 0 })]))
      .toEqual([[201, 1], [202, 0]]);
  });
});
