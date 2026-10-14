/**
 * The S3 auto-import recognises camera RAW files the way the file watcher
 * does: by extension, gated on the RAW opt-in in general_allowed_file_types.
 * mime-db knows few RAW types, so the MIME lookup alone skipped a .cr2 or
 * .nef for good.
 */
const fs = require('fs');
const path = require('path');
const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('s3AutoImporter: camera RAW files', () => {
  let db; let cleanup; let processEvent; let clearAllowedTypesCache; let counter = 0;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ processEvent } = require('../../src/services/s3AutoImporter').__test);
    ({ clearAllowedTypesCache } = require('../../src/services/uploadSettings'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function allowFileTypes(value) {
    await db('app_settings').where({ setting_key: 'general_allowed_file_types' }).del();
    await db('app_settings').insert({ setting_key: 'general_allowed_file_types', setting_value: JSON.stringify(value), setting_type: 'general' });
    clearAllowedTypesCache();
  }

  async function importFile(name) {
    counter += 1;
    const slug = `s3-raw-${counter}`;
    const inserted = await db('events').insert({
      slug, event_type: 'wedding', event_name: `S3 Raw ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `s3-raw-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    const event = await db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    // Not a decodable RAW: the preview extraction fails, and the row is
    // imported without dimensions, as for any image sharp cannot measure.
    await fs.promises.writeFile(path.join(dir, name), Buffer.from('not really a raw file'));
    const bucket = { list: async () => [{ key: `events/active/${slug}/${name}`, size: 21 }] };
    // A key is imported on the second poll that lists it.
    await processEvent(event, bucket);
    await processEvent(event, bucket);
    return db('photos').where({ event_id: event.id }).first();
  }

  it('imports a RAW the MIME lookup does not know, once RAW is allowed', async () => {
    await allowFileTypes('jpg,jpeg,png,webp,cr2');
    const row = await importFile('shot.cr2');
    expect(row).toMatchObject({ filename: 'shot.cr2', media_type: 'image', mime_type: 'image/x-canon-cr2' });
  }, 30000);

  it('skips a RAW while its extension is not allowed', async () => {
    await allowFileTypes('jpg,jpeg,png,webp');
    expect(await importFile('shot.nef')).toBeUndefined();
  }, 30000);
});
