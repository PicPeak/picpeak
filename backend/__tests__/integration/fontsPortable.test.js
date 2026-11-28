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
});
afterAll(async () => { if (cleanup) await cleanup(); });

test('an export carries the uploaded fonts', async () => {
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const out = await createPicpeak({ includePhotos: false });
  const file = out.path || out.filePath || out;
  const zip = new StreamZip.async({ file });
  try {
    const names = Object.keys(await zip.entries());
    expect(names).toEqual(expect.arrayContaining(['files/fonts/Studio-Serif/400.woff2', 'files/fonts/Studio-Serif/meta.json']));
  } finally {
    await zip.close();
  }
});

test('the import takes font files and a family\'s meta.json into fonts/, nothing else', () => {
  const { importFilePathProblem } = require('../../src/services/picpeakImportService');
  expect(importFilePathProblem('fonts/Studio-Serif/400.woff2')).toBeNull();
  expect(importFilePathProblem('fonts/Studio-Serif/700.ttf')).toBeNull();
  expect(importFilePathProblem('fonts/Studio-Serif/meta.json')).toBeNull();
  for (const bad of ['fonts/Studio-Serif/payload.html', 'fonts/Studio-Serif/x.js', 'fonts/x.woff2', 'fonts/A/B/400.woff2', 'fonts/Studio-Serif/notes.txt']) {
    expect([bad, importFilePathProblem(bad)]).toEqual([bad, expect.any(String)]);
  }
});

test('kept in an object store, fonts belong to the recovery inventory', () => {
  expect(require('../../src/services/recoveryFiles').MANAGED_ROOTS).toContain('fonts');
});
