'use strict';
/**
 * Uploaded fonts (issue 2618) are their own only copy: they travel in a
 * .picpeak export and come back with its import, and, kept in an object
 * store, belong to the recovery inventory like the website's images. The
 * import keeps the served fonts/ tree to font files.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
const fs = require('fs');
const path = require('path');
const StreamZip = require('node-stream-zip');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup;
beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const dir = path.join(process.env.STORAGE_PATH, 'fonts', 'Studio-Serif');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '400.woff2'), Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ generic: 'serif' }));
  // What a font download brings along: its licence and notes.
  fs.writeFileSync(path.join(dir, 'OFL.txt'), 'SIL Open Font License 1.1');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Studio Serif');
  // And what does not belong in a served folder.
  fs.writeFileSync(path.join(dir, 'preview.html'), '<script>x()</script>');
  fs.writeFileSync(path.join(dir, 'huge-notes.txt'), 'x'.repeat(300 * 1024));
});
afterAll(async () => { if (cleanup) await cleanup(); });

test('an export carries the uploaded fonts', async () => {
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const out = await createPicpeak({ includePhotos: false });
  const file = out.path || out.filePath || out;
  const zip = new StreamZip.async({ file });
  try {
    const names = Object.keys(await zip.entries());
    expect(names).toEqual(expect.arrayContaining(['files/fonts/Studio-Serif/400.woff2', 'files/fonts/Studio-Serif/meta.json',
      'files/fonts/Studio-Serif/OFL.txt', 'files/fonts/Studio-Serif/README.md']));
    expect(names).not.toContain('files/fonts/Studio-Serif/preview.html');
    expect(names).not.toContain('files/fonts/Studio-Serif/huge-notes.txt');
    // One rule on both sides: the import takes every file the export writes.
    const { importFilePathProblem } = require('../../src/services/picpeakImportService');
    for (const name of names.filter((n) => n.startsWith('files/fonts/'))) {
      expect([name, importFilePathProblem(name.slice('files/'.length))]).toEqual([name, null]);
    }
  } finally {
    await zip.close();
  }
});

test('the import takes font files and a family\'s meta.json into fonts/, nothing else', () => {
  const { importFilePathProblem } = require('../../src/services/picpeakImportService');
  expect(importFilePathProblem('fonts/Studio-Serif/400.woff2')).toBeNull();
  expect(importFilePathProblem('fonts/Studio-Serif/700.ttf')).toBeNull();
  expect(importFilePathProblem('fonts/Studio-Serif/meta.json')).toBeNull();
  for (const licence of ['fonts/Studio-Serif/OFL.txt', 'fonts/Studio-Serif/LICENSE', 'fonts/Studio-Serif/LICENCE.md', 'fonts/Studio-Serif/README', 'fonts/Studio-Serif/FONTLOG.txt']) {
    expect([licence, importFilePathProblem(licence)]).toEqual([licence, null]);
  }
  for (const bad of ['fonts/Studio-Serif/payload.html', 'fonts/Studio-Serif/x.js', 'fonts/x.woff2', 'fonts/A/B/400.woff2', 'fonts/Studio-Serif/notes.pdf', 'fonts/Studio-Serif/.hidden.txt']) {
    expect([bad, importFilePathProblem(bad)]).toEqual([bad, expect.any(String)]);
  }
});

test('kept in an object store, fonts belong to the recovery inventory', () => {
  expect(require('../../src/services/recoveryFiles').MANAGED_ROOTS).toContain('fonts');
});

describe('with an object store, fonts only on this disk still travel', () => {
  // An S3-like store holding one uploaded font; another font only on this disk.
  const { Readable } = require('stream');
  const objects = new Map([['fonts/Bucket-Serif/400.woff2', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 7)])]]);
  const store = {
    kind: () => 's3',
    list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: objects.get(key).length, mtime: new Date() })),
    get: async (key) => Readable.from([objects.get(key)]),
    stat: async (key) => (objects.has(key) ? { size: objects.get(key).length, mtime: new Date() } : null),
    exists: async (key) => objects.has(key),
  };
  beforeAll(() => {
    const dir = path.join(process.env.STORAGE_PATH, 'fonts', 'Disk-Only');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '700.woff2'), Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 9)]));
    require('../../src/services/storage').setStorageForTesting(store);
  });
  afterAll(() => require('../../src/services/storage').resetStorage());

  const keysOf = (files) => files.map((f) => String(f.relativePath || f.rel).split(path.sep).join('/'));

  test('the file backup inventory has the disk-only font beside the stored one', async () => {
    const backupService = require('../../src/services/backupService');
    const keys = keysOf(await backupService.getFilesToBackup({}));
    expect(keys).toEqual(expect.arrayContaining(['fonts/Disk-Only/700.woff2', 'fonts/Bucket-Serif/400.woff2']));
  });

  test('the export collects the disk-only font beside the stored one', async () => {
    const { collectFiles } = require('../../src/services/picpeakExportService');
    const keys = keysOf(await collectFiles(false, []));
    expect(keys).toEqual(expect.arrayContaining(['fonts/Disk-Only/700.woff2', 'fonts/Bucket-Serif/400.woff2']));
  });
});
