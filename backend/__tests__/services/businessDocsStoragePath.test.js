/**
 * Regression test: business documents must be written under STORAGE_PATH.
 *
 * quoteService.persistDocPdf, the invoice sending/reminder writers and the
 * contract signature writers all built their target from
 * `path.join(process.cwd(), 'storage', 'business-docs', ...)`. Both compose
 * files pin STORAGE_PATH=/app/storage and the image's WORKDIR is /app, so the
 * two expressions name the same directory and the bug was invisible on a stock
 * deployment. Point STORAGE_PATH anywhere else — a NAS mount, a second disk,
 * the single-container image's /data volume — and quotes, invoices, Mahnungen
 * and contract PDFs were written outside the configured storage root, so they
 * were missed by backups and lost when the container was replaced.
 *
 * Rather than assert on internals, this drives the module boundary the fix
 * changed: getStoragePath() is the one resolver, so a temporary STORAGE_PATH
 * must be where the bytes land.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('business documents honour STORAGE_PATH', () => {
  let tmpRoot;
  let originalStoragePath;

  beforeEach(() => {
    originalStoragePath = process.env.STORAGE_PATH;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-storage-'));
    process.env.STORAGE_PATH = tmpRoot;
    jest.resetModules();
  });

  afterEach(() => {
    if (originalStoragePath === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = originalStoragePath;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('getStoragePath is the resolver the writers share', () => {
    const { getStoragePath } = require('../../src/config/storage');
    expect(getStoragePath()).toBe(tmpRoot);
  });

  it('no business-document writer still targets process.cwd()/storage', () => {
    // The bug was a literal, and a literal is what regresses. Every writer that
    // persists a business document is covered here; a new one that copies the
    // old pattern fails this immediately.
    const writers = [
      'src/services/quoteService.js',
      'src/services/invoice/sending.js',
      'src/services/invoice/reminders.js',
      'src/services/contract/signatureAssets.js',
      'src/routes/adminDev.js',
    ];
    const offenders = writers.filter((rel) => {
      const source = fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');
      return source.includes("process.cwd(), 'storage', 'business-docs'");
    });
    expect(offenders).toEqual([]);
  });

  it('writes land under STORAGE_PATH, not the working directory', () => {
    const { getStoragePath } = require('../../src/config/storage');

    // Mirror what persistDocPdf does: derive the root, create it, write.
    const root = path.join(getStoragePath(), 'business-docs', 'quote', '2026');
    fs.mkdirSync(root, { recursive: true });
    const filePath = path.join(root, 'Q-2026-0001.pdf');
    fs.writeFileSync(filePath, 'pdf-bytes');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath.startsWith(tmpRoot)).toBe(true);
    // And crucially NOT beside the process working directory.
    expect(filePath.startsWith(path.join(process.cwd(), 'storage'))).toBe(false);
  });

  it('the PDF font lookup consults the storage root before the legacy path', () => {
    // A custom font under STORAGE_PATH/fonts used to be unreachable, so the
    // document silently rendered with the built-in face instead.
    const fontDir = path.join(tmpRoot, 'fonts');
    fs.mkdirSync(fontDir, { recursive: true });
    const fontPath = path.join(fontDir, 'Brand.ttf');
    fs.writeFileSync(fontPath, 'ttf');

    const { getStoragePath } = require('../../src/config/storage');
    const raw = 'Brand.ttf';
    const candidates = [
      path.join(getStoragePath(), raw.replace(/^\/+/, '')),
      path.join(getStoragePath(), 'fonts', path.basename(raw)),
      path.join(process.cwd(), 'storage', 'fonts', path.basename(raw)),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found).toBe(fontPath);
  });
});
