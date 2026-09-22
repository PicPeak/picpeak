'use strict';

/**
 * Documents a row names in the legacy root (`<cwd>/storage`) while
 * STORAGE_PATH points elsewhere reach both archive kinds, and a restore on
 * another machine opens them again with their own bytes.
 *
 * Three inbound documents: one only in the legacy root, one in the legacy
 * root whose suffix the storage root also holds with different bytes, and the
 * row naming that storage-root file.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let base;
let cwdSpy;
let originalStorage;

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

function useInstall(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'root'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  process.env.STORAGE_PATH = path.join(dir, 'root');
  if (cwdSpy) cwdSpy.mockRestore();
  cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(path.join(dir, 'app'));
  return { root: path.join(dir, 'root'), legacy: path.join(dir, 'app', 'storage') };
}

async function seedDocuments() {
  const { root, legacy } = useInstall('source');
  const onlyLegacy = path.join(legacy, 'business-docs', 'inbound', '2026', 'only.pdf');
  const shadowed = path.join(legacy, 'business-docs', 'inbound', '2026', 'same.pdf');
  write(onlyLegacy, 'LEGACY-ONLY');
  write(shadowed, 'LEGACY-SAME');
  write(path.join(root, 'business-docs', 'inbound', '2026', 'same.pdf'), 'ROOT-SAME');
  await db('inbound_documents').del();
  await db('inbound_documents').insert([
    { original_filename: 'only', file_path: onlyLegacy },
    { original_filename: 'shadowed', file_path: shadowed },
    { original_filename: 'root', file_path: 'business-docs/inbound/2026/same.pdf' },
  ]);
}

async function contents() {
  const { resolveStoredPath } = require('../../src/utils/storedPath');
  const rows = await db('inbound_documents').orderBy('original_filename');
  const out = {};
  for (const row of rows) {
    const file = resolveStoredPath(row.file_path);
    out[row.original_filename] = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  return out;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  originalStorage = process.env.STORAGE_PATH;
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-legacy-archive-'));
}, 120000);

afterAll(async () => {
  if (cwdSpy) cwdSpy.mockRestore();
  process.env.STORAGE_PATH = originalStorage;
  fs.rmSync(base, { recursive: true, force: true });
  await cleanup();
});

afterEach(() => {
  fs.rmSync(path.join(base, 'source'), { recursive: true, force: true });
  fs.rmSync(path.join(base, 'target'), { recursive: true, force: true });
});

describe('legacy-root documents in archives', () => {
  it('a .picpeak restore on another machine opens every document with its own bytes', async () => {
    const { createPicpeak } = require('../../src/services/picpeakExportService');
    const { importFromPicpeak } = require('../../src/services/picpeakImportService');
    await seedDocuments();
    const { filePath, manifest } = await createPicpeak({ includePhotos: false });
    try {
      expect(manifest.file_count).toBe(3);

      fs.rmSync(path.join(base, 'source'), { recursive: true, force: true });
      useInstall('target');
      await importFromPicpeak({ picpeakPath: filePath });

      expect(await contents()).toEqual({ only: 'LEGACY-ONLY', shadowed: 'LEGACY-SAME', root: 'ROOT-SAME' });
      const paths = (await db('inbound_documents').orderBy('original_filename')).map((r) => r.file_path);
      expect(paths).toEqual([
        'business-docs/inbound/2026/only.pdf',
        'business-docs/inbound/2026/same.pdf',
        'business-docs/inbound/2026/legacy/same.pdf',
      ]);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('the backup walker includes them under the mapped path, and a restore points the rows there', async () => {
    const backupService = require('../../src/services/backupService');
    const {
      applyStoredPathMap, storedPathMap, storedPathChecksums, holdsBytes,
    } = require('../../src/utils/legacyStoredFiles');
    await seedDocuments();
    const files = await backupService.getFilesToBackup(false);
    const legacy = files.filter((f) => f.legacyValues)
      .map((f) => ({
        rel: f.relativePath.split(path.sep).join('/'), body: fs.readFileSync(f.path, 'utf8'),
        values: f.legacyValues, sha256: f.legacySha256,
      }));
    expect(legacy.map(({ rel, body }) => ({ rel, body })).sort((a, b) => a.rel.localeCompare(b.rel))).toEqual([
      { rel: 'business-docs/inbound/2026/legacy/same.pdf', body: 'LEGACY-SAME' },
      { rel: 'business-docs/inbound/2026/only.pdf', body: 'LEGACY-ONLY' },
    ]);

    // The restore: the backed-up files land under the new root, the rows come
    // back as they were, then the manifest's map is applied.
    const map = storedPathMap(legacy);
    const sums = storedPathChecksums(legacy);
    const sourceRoot = process.env.STORAGE_PATH;
    const backedUp = [...files.map((f) => ({ rel: f.relativePath.split(path.sep).join('/'), abs: f.path }))];
    const copies = backedUp.map(({ rel, abs }) => ({ rel, body: fs.readFileSync(abs) }));
    expect(sourceRoot).toContain('source');
    fs.rmSync(path.join(base, 'source'), { recursive: true, force: true });
    const { root } = useInstall('target');
    const verify = (rel) => holdsBytes(path.join(root, ...rel.split('/')), sums[rel]);
    // A different document at a mapped path (a partial restore) is not adopted.
    write(path.join(root, 'business-docs', 'inbound', '2026', 'only.pdf'), 'SOMETHING-ELSE');
    expect(await applyStoredPathMap(db, map, verify)).toBe(0);

    for (const { rel, body } of copies) write(path.join(root, ...rel.split('/')), body);
    const updated = await applyStoredPathMap(db, map, verify);
    expect(updated).toBe(2);
    expect(await contents()).toEqual({ only: 'LEGACY-ONLY', shadowed: 'LEGACY-SAME', root: 'ROOT-SAME' });
  });

  it('leaves out a legacy file reached through a symlink to outside the legacy root', async () => {
    const { collectLegacyStoredFiles } = require('../../src/utils/legacyStoredFiles');
    const { legacy } = useInstall('source');
    const outside = path.join(base, 'source', 'outside');
    write(path.join(outside, 'secret.pdf'), 'OUTSIDE');
    fs.mkdirSync(path.join(legacy, 'business-docs'), { recursive: true });
    fs.symlinkSync(outside, path.join(legacy, 'business-docs', 'inbound'));
    await db('inbound_documents').del();
    await db('inbound_documents').insert({
      original_filename: 'link', file_path: path.join(legacy, 'business-docs', 'inbound', 'secret.pdf'),
    });
    expect(await collectLegacyStoredFiles(db)).toEqual([]);
  });

  it('applies the backup exclusion patterns to legacy files', async () => {
    const backupService = require('../../src/services/backupService');
    await seedDocuments();
    const files = await backupService.getFilesToBackup({ backup_exclude_patterns: ['only.*', 'legacy'] });
    const legacyRels = files.filter((f) => f.legacyValues).map((f) => f.relativePath.split(path.sep).join('/'));
    // only.pdf by name; same.pdf lands in a legacy/ folder, excluded by the directory name.
    expect(legacyRels).toEqual([]);
    const withoutPatterns = await backupService.getFilesToBackup({});
    expect(withoutPatterns.filter((f) => f.legacyValues)).toHaveLength(2);
  });

  it('refuses a map entry that is not a plain storage-relative path', async () => {
    const { applyStoredPathMap } = require('../../src/utils/legacyStoredFiles');
    await db('inbound_documents').del();
    await db('inbound_documents').insert({ original_filename: 'x', file_path: '/old/storage/business-docs/x.pdf' });
    const updated = await applyStoredPathMap(db, {
      '/old/storage/business-docs/x.pdf': 'business-docs/../../etc/passwd',
    }, async () => true);
    expect(updated).toBe(0);
    expect((await db('inbound_documents').first()).file_path).toBe('/old/storage/business-docs/x.pdf');
  });
});
