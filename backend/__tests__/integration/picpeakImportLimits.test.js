'use strict';

// A .picpeak upload is capped by multer, but the archive inside can declare
// entries that inflate far beyond that, and the import used to extract every
// entry to the temp dir before looking at any of them. The import now refuses
// an archive whose entry count, expanded size or free-space need is too large,
// and a manifest that is too big to be one, before anything is written.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let tmpDir;
let createPicpeak;
let importFromPicpeak;
let readManifestFromZip;
let assertArchiveWithinLimits;
let backupFile;

const LIMIT_ENV = [
  'PICPEAK_IMPORT_MAX_ENTRIES',
  'PICPEAK_IMPORT_MAX_EXPANDED_BYTES',
  'PICPEAK_IMPORT_MAX_MANIFEST_BYTES',
];

async function getMarker() {
  const row = await db('app_settings').where({ setting_key: 'limits_marker' }).first();
  return row ? JSON.parse(row.setting_value) : null;
}
async function setMarker(value) {
  await db('app_settings')
    .insert({ setting_key: 'limits_marker', setting_value: JSON.stringify(value), setting_type: 'string' })
    .onConflict('setting_key').merge();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak, readManifestFromZip, assertArchiveWithinLimits } = require('../../src/services/picpeakImportService'));
  await setMarker('in_backup');
  ({ filePath: backupFile } = await createPicpeak({ includePhotos: false }));
  await setMarker('current');
}, 120000);

afterEach(() => {
  for (const name of LIMIT_ENV) delete process.env[name];
  jest.restoreAllMocks();
});

afterAll(async () => {
  if (backupFile) fs.rmSync(path.dirname(backupFile), { recursive: true, force: true });
  await cleanup();
});

describe('.picpeak import limits', () => {
  it('refuses an archive with more entries than allowed and restores nothing', async () => {
    process.env.PICPEAK_IMPORT_MAX_ENTRIES = '1';

    await expect(importFromPicpeak({ picpeakPath: backupFile, currentAdminId: null }))
      .rejects.toMatchObject({ statusCode: 413, message: expect.stringMatching(/PICPEAK_IMPORT_MAX_ENTRIES/) });
    expect(await getMarker()).toBe('current');
  });

  it('refuses an archive that expands beyond the byte limit', async () => {
    process.env.PICPEAK_IMPORT_MAX_EXPANDED_BYTES = '10';

    await expect(importFromPicpeak({ picpeakPath: backupFile, currentAdminId: null }))
      .rejects.toMatchObject({ statusCode: 413, message: expect.stringMatching(/PICPEAK_IMPORT_MAX_EXPANDED_BYTES/) });
    expect(await getMarker()).toBe('current');
  });

  it('refuses an archive that does not fit into the free space of the extraction directory', async () => {
    jest.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4 });

    await expect(importFromPicpeak({ picpeakPath: backupFile, currentAdminId: null }))
      .rejects.toMatchObject({ statusCode: 507 });
    expect(await getMarker()).toBe('current');
  });

  it('refuses a manifest too large to be a PicPeak manifest', async () => {
    process.env.PICPEAK_IMPORT_MAX_MANIFEST_BYTES = '10';

    await expect(readManifestFromZip(backupFile)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('counts files and expanded bytes, skipping directories', async () => {
    const result = await assertArchiveWithinLimits([
      { name: 'data/', isDirectory: true, size: 0 },
      { name: 'data/a.ndjson', isDirectory: false, size: 120 },
      { name: 'manifest.json', isDirectory: false, size: 30 },
    ], tmpDir);

    expect(result).toEqual({ entries: 2, expandedBytes: 150 });
  });
});
