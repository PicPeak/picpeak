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

  it('counts directories as entries, since each one is created on disk', async () => {
    const result = await assertArchiveWithinLimits([
      { name: 'data/', isDirectory: true, size: 0 },
      { name: 'data/a.ndjson', isDirectory: false, size: 120 },
      { name: 'manifest.json', isDirectory: false, size: 30 },
    ], tmpDir);
    expect(result).toEqual({ entries: 3, expandedBytes: 150 });

    process.env.PICPEAK_IMPORT_MAX_ENTRIES = '1';
    await expect(assertArchiveWithinLimits([
      { name: 'manifest.json', isDirectory: false, size: 30 },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `d${i}/`, isDirectory: true, size: 0 })),
    ], tmpDir)).rejects.toMatchObject({ statusCode: 413 });
  });
});

// Archives whose recorded sizes understate the real content. The declared
// sizes are rewritten to 1 byte in both the local and the central headers, and
// the data-descriptor flag is set, so node-stream-zip neither sees nor checks
// the real length.
describe('.picpeak import limits on real bytes', () => {
  const StreamZip = require('node-stream-zip');
  let extractWithinLimits;

  beforeAll(() => {
    ({ extractWithinLimits } = require('../../src/services/picpeakImportService'));
  });

  function zipEntry(name, content) {
    const zlib = require('zlib');
    const nameBuf = Buffer.from(name);
    const data = zlib.deflateRawSync(content);
    const crc = zlib.crc32 ? zlib.crc32(content) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0008, 6); // data descriptor: sizes not verified
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(1, 22); // declared uncompressed size: 1 byte
    local.writeUInt16LE(nameBuf.length, 26);
    return { name, nameBuf, data, crc, local };
  }

  function craftArchive(file, entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries.map(([name, content]) => zipEntry(name, content))) {
      parts.push(e.local, e.nameBuf, e.data);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0008, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.data.length, 20);
      c.writeUInt32LE(1, 24); // declared uncompressed size: 1 byte
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(offset, 42);
      central.push(c, e.nameBuf);
      offset += e.local.length + e.nameBuf.length + e.data.length;
    }
    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(file, Buffer.concat([...parts, centralBuf, end]));
  }

  it('refuses a manifest whose real size exceeds the cap though it declares 1 byte', async () => {
    const file = path.join(tmpDir, 'understated-manifest.picpeak');
    craftArchive(file, [['manifest.json', Buffer.from(`{"kind":"picpeak-backup","pad":"${'x'.repeat(1024 * 1024)}"}`)]]);
    process.env.PICPEAK_IMPORT_MAX_MANIFEST_BYTES = '100';

    await expect(readManifestFromZip(file)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('stops extracting at the byte cap though every entry declares 1 byte', async () => {
    const file = path.join(tmpDir, 'understated-data.picpeak');
    craftArchive(file, [
      ['manifest.json', Buffer.from('{}')],
      ['data/big.ndjson', Buffer.alloc(2 * 1024 * 1024, 0x61)],
    ]);
    process.env.PICPEAK_IMPORT_MAX_EXPANDED_BYTES = '100';
    const staging = fs.mkdtempSync(path.join(tmpDir, 'extract-'));
    const zip = new StreamZip.async({ file });

    try {
      const entries = Object.values(await zip.entries());
      await expect(assertArchiveWithinLimits(entries, staging)).resolves.toBeTruthy();
      await expect(extractWithinLimits(zip, entries, staging)).rejects.toMatchObject({ statusCode: 413 });
    } finally {
      await zip.close();
    }
    const big = path.join(staging, 'data', 'big.ndjson');
    expect(fs.existsSync(big) ? fs.statSync(big).size : 0).toBeLessThan(2 * 1024 * 1024);
  });
});
