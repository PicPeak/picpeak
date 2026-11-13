/**
 * Migrations 259 and 349 return early when their column already exists, so
 * the ledger re-run after a portable restore skips their backfills for an
 * older archive's rows (issue 2481). The import applies them itself:
 * - events without custom_theme_enabled get 259's rule against the RESTORED
 *   Branding theme, so a gallery with its own theme keeps it;
 * - photos without focal_checked and without a point come back as 0, so
 *   focalPointBackfill looks at them.
 * Rows of an archive that has the columns keep their values.
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

const LOCAL_BRANDING = { primaryColor: '#111111', backgroundColor: '#ffffff' };
const ARCHIVE_BRANDING = { primaryColor: '#222222', backgroundColor: '#000000' };

describe('portable import backfills of migrations 259 and 349 (issue 2481)', () => {
  let db;
  let cleanup;
  let tmpDir;
  let run = 0;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-legacy-backfill-'));
  }, 120000);

  afterAll(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('app_settings').where({ setting_key: 'theme_config' }).del();
    await db('app_settings').insert({ setting_key: 'theme_config', setting_value: JSON.stringify(LOCAL_BRANDING), setting_type: 'theme', updated_at: new Date().toISOString() });
  });

  const event = (id, extra = {}) => ({
    id, slug: `legacy-${id}`, event_type: 'wedding', event_name: `Legacy ${id}`, event_date: '2026-08-01',
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
    share_link: `/gallery/legacy-${id}/share`, share_token: `legacy-${id}-share`,
    expires_at: new Date(Date.now() + 86400000).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
    created_at: new Date().toISOString(), ...extra,
  });

  const photo = (id, eventId, extra = {}) => ({
    id, event_id: eventId, filename: `p${id}.jpg`, original_filename: `p${id}.jpg`, path: `legacy/p${id}.jpg`,
    type: 'individual', media_type: 'image', mime_type: 'image/jpeg', processing_status: 'complete',
    thumbnail_path: `thumbnails/thumb_p${id}.jpg`, uploaded_at: new Date().toISOString(), ...extra,
  });

  async function importArchive(data) {
    run += 1;
    const dataDir = path.join(tmpDir, `data-${run}`);
    await fs.promises.mkdir(dataDir, { recursive: true });
    for (const [table, rows] of Object.entries(data)) {
      await fs.promises.writeFile(path.join(dataDir, `${table}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    const tables = Object.keys(data).sort();
    const { replaceAllTables } = require('../../src/services/picpeakImportService');
    await db.transaction((trx) => replaceAllTables(tables, dataDir, null, null, { executor: trx, allTables: ['app_settings', 'events', 'photos'] }));
  }

  const archiveSettings = () => [{ setting_key: 'theme_config', setting_value: JSON.stringify(ARCHIVE_BRANDING), setting_type: 'theme', updated_at: new Date().toISOString() }];

  const themeFlags = async () => Object.fromEntries(
    Array.from(await db('events').orderBy('id').select('id', 'custom_theme_enabled'))
      .map((r) => [r.id, Boolean(Number(r.custom_theme_enabled))]),
  );

  it('keeps the own theme of galleries from an archive made before 259, judged against the restored Branding', async () => {
    await importArchive({
      app_settings: archiveSettings(),
      events: [
        event(11, { color_theme: JSON.stringify(ARCHIVE_BRANDING) }), // copy of the restored Branding
        event(12, { color_theme: JSON.stringify(LOCAL_BRANDING) }), // differs from the restored Branding
        event(13, { css_template_id: 1 }),
        event(14), // no theme
      ],
    });
    expect(await themeFlags()).toEqual({ 11: false, 12: true, 13: true, 14: false });
  });

  it('keeps custom_theme_enabled as the archive has it', async () => {
    await importArchive({
      app_settings: archiveSettings(),
      events: [
        event(21, { color_theme: JSON.stringify(LOCAL_BRANDING), custom_theme_enabled: 0 }),
        event(22, { custom_theme_enabled: 1 }),
      ],
    });
    expect(await themeFlags()).toEqual({ 21: false, 22: true });
  });

  it('handles an archive whose event rows carry the flag on some rows only', async () => {
    await importArchive({
      app_settings: archiveSettings(),
      events: [
        event(51, { custom_theme_enabled: 0 }),
        event(52, { css_template_id: 1 }), // no flag: 259's rule applies
        event(53), // no flag, no theme
      ],
    });
    expect(await themeFlags()).toEqual({ 51: false, 52: true, 53: false });
  });

  const focalFlags = async () => Array.from(await db('photos').orderBy('id').select('id', 'focal_checked'))
    .map((r) => [r.id, Number(r.focal_checked)]);

  it('queues the photos of an archive made before 349 that have no point for the focal pass', async () => {
    await importArchive({
      events: [event(31)],
      photos: [
        photo(301, 31),
        photo(302, 31, { focal_x: 0.3, focal_y: 0.4, focal_source: 'face' }),
      ],
    });
    expect(await focalFlags()).toEqual([[301, 0], [302, 1]]);
  });

  it('keeps focal_checked as the archive has it', async () => {
    await importArchive({
      events: [event(41)],
      photos: [photo(401, 41, { focal_checked: 1 }), photo(402, 41, { focal_checked: 0 })],
    });
    expect(await focalFlags()).toEqual([[401, 1], [402, 0]]);
  });
});
