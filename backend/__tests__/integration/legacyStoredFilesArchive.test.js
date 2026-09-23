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

  it('records the archived bytes checksum, not a stale collection-time one, when the legacy file changes mid-backup', async () => {
    // Regression test for the collect-time vs archive-time TOCTOU:
    // collectLegacyStoredFiles hashes the legacy file once, well before
    // performLocalBackup actually reads and copies it into the archive. A
    // write landing on the file in between used to leave the manifest's
    // stored_path_sha256 naming bytes the archive never actually holds.
    const crypto = require('crypto');
    const backupService = require('../../src/services/backupService');
    const { root, legacy } = useInstall('source');
    const legacyFile = path.join(legacy, 'business-docs', 'inbound', '2026', 'race.pdf');
    write(legacyFile, 'BEFORE-BYTES');
    await db('inbound_documents').del();
    await db('inbound_documents').insert({ original_filename: 'race', file_path: legacyFile });

    await db('app_settings').where('setting_type', 'backup').del();
    const destPath = path.join(root, '..', 'destination');
    fs.mkdirSync(destPath, { recursive: true });
    await db('app_settings').insert([
      { setting_key: 'backup_destination_type', setting_value: JSON.stringify('local'), setting_type: 'backup' },
      { setting_key: 'backup_destination_path', setting_value: JSON.stringify(destPath), setting_type: 'backup' },
      { setting_key: 'backup_enabled', setting_value: JSON.stringify(true), setting_type: 'backup' },
      { setting_key: 'backup_database_inline_dump', setting_value: JSON.stringify(false), setting_type: 'backup' },
    ]).onConflict('setting_key').merge();
    const fakeDump = path.join(destPath, 'fake.sql.gz');
    fs.writeFileSync(fakeDump, 'pretend dump');
    await db('database_backup_runs').insert({
      started_at: new Date(),
      completed_at: new Date(),
      status: 'completed',
      backup_type: 'pg',
      file_path: fakeDump,
      file_size_bytes: fs.statSync(fakeDump).size,
      destination_path: fakeDump,
    });

    // Simulate a write landing on the legacy file right after the collection
    // walk (collectLegacyStoredFiles) hashes it, before the archive step
    // reads it again for the actual copy. collectLegacyStoredFiles hashes the
    // realpath'd file (fs.realpathSync), which on macOS differs from the raw
    // tmpdir path (/var/... vs /private/var/...), so compare realpaths.
    const realLegacyFile = fs.realpathSync(legacyFile);
    const realCreateReadStream = fs.createReadStream.bind(fs);
    let raced = false;
    const streamSpy = jest.spyOn(fs, 'createReadStream').mockImplementation((filePath, ...args) => {
      const stream = realCreateReadStream(filePath, ...args);
      if (!raced && typeof filePath === 'string' && fs.existsSync(filePath)
          && fs.realpathSync(filePath) === realLegacyFile) {
        raced = true;
        stream.on('end', () => { fs.writeFileSync(legacyFile, 'AFTER-RACE-BYTES'); });
      }
      return stream;
    });
    try {
      await backupService.runBackup(true);
    } finally {
      streamSpy.mockRestore();
    }

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');
    const { manifest } = await backupService.getBackupManifest(run.id);
    const rel = 'business-docs/inbound/2026/race.pdf';
    const recordedSha256 = manifest.metadata.stored_path_sha256[rel];

    const archivedBytes = fs.readFileSync(path.join(destPath, ...rel.split('/')));
    expect(archivedBytes.toString()).toBe('AFTER-RACE-BYTES');
    expect(recordedSha256).toBe(crypto.createHash('sha256').update(archivedBytes).digest('hex'));
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

  it('keeps a legacy document off a path another row names even when that file is missing', async () => {
    const { collectLegacyStoredFiles } = require('../../src/utils/legacyStoredFiles');
    const { legacy } = useInstall('source');
    const legacyFile = path.join(legacy, 'business-docs', 'inbound', '2026', 'gone.pdf');
    write(legacyFile, 'LEGACY-GONE');
    await db('inbound_documents').del();
    await db('inbound_documents').insert([
      { original_filename: 'legacy', file_path: legacyFile },
      { original_filename: 'missing', file_path: 'business-docs/inbound/2026/gone.pdf' },
    ]);
    const [entry] = await collectLegacyStoredFiles(db);
    expect(entry.rel).toBe('business-docs/inbound/2026/legacy/gone.pdf');

    // The same for a missing path the import would relocate onto that suffix.
    await db('inbound_documents').where({ original_filename: 'missing' })
      .update({ file_path: 'previous-storage/business-docs/inbound/2026/gone.pdf' });
    const [again] = await collectLegacyStoredFiles(db);
    expect(again.rel).toBe('business-docs/inbound/2026/legacy/gone.pdf');
  });

  it('a restore without the database leaves a row whose own document is still readable', async () => {
    const { applyStoredPathMap } = require('../../src/utils/legacyStoredFiles');
    const { legacy, root } = useInstall('source');
    const live = path.join(legacy, 'business-docs', 'inbound', '2026', 'live.pdf');
    write(live, 'NEWER');
    write(path.join(root, 'business-docs', 'inbound', '2026', 'legacy', 'live.pdf'), 'ARCHIVED');
    await db('inbound_documents').del();
    await db('inbound_documents').insert({ original_filename: 'live', file_path: live });
    const map = { [live]: 'business-docs/inbound/2026/legacy/live.pdf' };
    expect(await applyStoredPathMap(db, map, async () => true, { onlyUnreadable: true })).toBe(0);
    fs.rmSync(live);
    // A different document at the unmapped suffix is a resolver fallback, not
    // the row's own file.
    write(path.join(root, 'business-docs', 'inbound', '2026', 'live.pdf'), 'OTHER');
    expect(await applyStoredPathMap(db, map, async () => true, { onlyUnreadable: true })).toBe(1);
  });

  it('does not collect a legacy file the storage walk already archives through a symlinked legacy root', async () => {
    const { collectLegacyStoredFiles } = require('../../src/utils/legacyStoredFiles');
    const { root, legacy } = useInstall('source');
    write(path.join(root, 'business-docs', 'inbound', '2026', 'x.pdf'), 'ROOT-X');
    fs.symlinkSync(root, legacy);
    await db('inbound_documents').del();
    await db('inbound_documents').insert({
      original_filename: 'x', file_path: path.join(legacy, 'business-docs', 'inbound', '2026', 'x.pdf'),
    });
    expect(await collectLegacyStoredFiles(db)).toEqual([]);
  });

  it('a partial restore leaves a row whose storage-relative legacy file is still there', async () => {
    const { applyStoredPathMap } = require('../../src/utils/legacyStoredFiles');
    const { root } = useInstall('source');
    // Legacy root inside the storage root: the row is relative to the root.
    const value = 'app-dir/storage/business-docs/inbound/2026/rel.pdf';
    write(path.join(root, ...value.split('/')), 'NEWER');
    await db('inbound_documents').del();
    await db('inbound_documents').insert({ original_filename: 'rel', file_path: value });
    const map = { [value]: 'business-docs/inbound/2026/legacy/rel.pdf' };
    expect(await applyStoredPathMap(db, map, async () => true, { onlyUnreadable: true })).toBe(0);
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

  it('verifies each entry immediately before its own update, not for the whole batch up front', async () => {
    // Regression test for the TOCTOU gap: applyStoredPathMap used to verify()
    // every entry first and only then run the batched updates, so a file
    // that changed after ITS OWN verify() but before ITS OWN update (while a
    // later entry's verify/update was still running) went unnoticed. Proven
    // here by call order: with the old batched shape, both verify() calls
    // ran before either update fired; with the fix, each entry's update
    // follows immediately after that same entry's verify().
    const { applyStoredPathMap } = require('../../src/utils/legacyStoredFiles');
    const { root } = useInstall('source');
    write(path.join(root, 'business-docs', 'inbound', '2026', 'a.pdf'), 'A');
    write(path.join(root, 'business-docs', 'inbound', '2026', 'b.pdf'), 'B');
    await db('inbound_documents').del();
    await db('inbound_documents').insert([
      { original_filename: 'a', file_path: '/old/a.pdf' },
      { original_filename: 'b', file_path: '/old/b.pdf' },
    ]);
    const map = {
      '/old/a.pdf': 'business-docs/inbound/2026/a.pdf',
      '/old/b.pdf': 'business-docs/inbound/2026/b.pdf',
    };

    const order = [];
    const verify = async (rel) => { order.push(`verify:${rel}`); return true; };

    // A thin trace over the real knex instance: applyStoredPathMap only
    // reaches `knex.schema.{hasTable,hasColumn}` and
    // `knex(table).where(column, value).update(...)`, so that's all this
    // needs to forward.
    const tracedDb = (table) => {
      const qb = db(table);
      const originalWhere = qb.where.bind(qb);
      return {
        where: (column, value) => {
          const whereQb = originalWhere(column, value);
          const originalUpdate = whereQb.update.bind(whereQb);
          whereQb.update = (payload) => {
            order.push(`update:${value}`);
            return originalUpdate(payload);
          };
          return whereQb;
        },
      };
    };
    tracedDb.schema = db.schema;

    const updated = await applyStoredPathMap(tracedDb, map, verify);
    expect(updated).toBe(2);

    const verifyA = order.indexOf('verify:business-docs/inbound/2026/a.pdf');
    const updateA = order.indexOf('update:/old/a.pdf');
    const verifyB = order.indexOf('verify:business-docs/inbound/2026/b.pdf');
    const updateB = order.indexOf('update:/old/b.pdf');
    // Each entry's own update comes right after its own verify, and before
    // the other entry's verify runs — proving the two are no longer split
    // into a verify-everything phase followed by an update-everything phase.
    expect(verifyA).toBeGreaterThanOrEqual(0);
    expect(updateA).toBeGreaterThan(verifyA);
    expect(updateA).toBeLessThan(verifyB);
    expect(updateB).toBeGreaterThan(verifyB);
  });
});
