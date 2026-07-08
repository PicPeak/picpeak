/**
 * Regression net for the business-docs coverage gap fixed in this PR.
 *
 * Prior to the fix, `getFilesToBackupInternal()` enumerated a fixed
 * list of storage subdirectories (events/active, events/archived,
 * thumbnails, previews, heroes, uploads) and silently omitted the
 * entire `business-docs/` tree. That meant every CRM PDF + signature
 * drawing — quotes, contracts (system-rendered + wet uploads),
 * invoices, Storno, imported historical invoices, and the customer
 * signature PNG/JPG drawn on the public signing page — fell outside
 * the in-app scheduled backup, leaving every `*_path` column on
 * `quotes` / `contracts` / `invoices` as a broken FK after restore.
 *
 * The fix is a single `scanDirectory(business-docs, ...)` call. This
 * suite pins the contract so a future refactor of the walker cannot
 * silently drop business-docs again.
 */

const fs = require('fs');
const path = require('path');

const { bootCrmDb } = require('./helpers/crmDb');

describe('backupService — business-docs is in the backup walker', () => {
  let cleanup;
  let backupService;
  let storagePath;

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;
    // Cold-require after bootCrmDb so backupService picks up the same
    // db instance + STORAGE_PATH the test harness configured.
    backupService = require('../../src/services/backupService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  function seed(relPath, content = 'dummy bytes for backup test') {
    const abs = path.join(storagePath, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('does not error when business-docs is absent', async () => {
    // Fresh harness has no business-docs/ tree at all. The walker
    // must short-circuit on ENOENT rather than throw — installs that
    // never used CRM features have to keep backing up fine.
    await expect(backupService.getFilesToBackup(false)).resolves.toEqual(expect.any(Array));
  });

  it('picks up every CRM-relevant business-docs subdirectory', async () => {
    // Seed one file in each of the five subpaths the renderer + import
    // routes write to. The signature path is the one most prone to be
    // forgotten — it lives one level deeper than the others (per-
    // contract subfolder, not per-year).
    seed('business-docs/quote/2026/Q-001.pdf');
    seed('business-docs/contract/2026/C-001.pdf');
    seed('business-docs/contract/signatures/42/customer-1700000000000.png');
    seed('business-docs/invoice/2026/INV-001.pdf');
    seed('business-docs/invoice-imports/2026/scan.pdf');

    const files = await backupService.getFilesToBackup(false);
    const rels = files.map((f) => f.relativePath);

    expect(rels).toEqual(expect.arrayContaining([
      'business-docs/quote/2026/Q-001.pdf',
      'business-docs/contract/2026/C-001.pdf',
      'business-docs/contract/signatures/42/customer-1700000000000.png',
      'business-docs/invoice/2026/INV-001.pdf',
      'business-docs/invoice-imports/2026/scan.pdf',
    ]));
  });

  it('walks newly-created business-docs files without needing a restart', async () => {
    // The walker reads the filesystem live on every call; this guards
    // against a future "cache the scan result at boot" optimisation
    // that would miss freshly-written PDFs (which is exactly what
    // happens during normal operation — every send writes a new file).
    seed('business-docs/invoice/2027/INV-NEW.pdf');

    const files = await backupService.getFilesToBackup(false);
    const rels = files.map((f) => f.relativePath);
    expect(rels).toContain('business-docs/invoice/2027/INV-NEW.pdf');
  });
});
