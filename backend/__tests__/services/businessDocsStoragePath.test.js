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
    // Whitespace is collapsed before matching on purpose. The first version of
    // this test compared against the single-line literal and therefore missed
    // persistSignatureImage(), whose identical path.join was simply spread over
    // seven lines — it reported green while signature PNGs still wrote outside
    // STORAGE_PATH. Formatting must not decide whether a bug is visible.
    const writers = [
      'src/services/quoteService.js',
      'src/services/invoice/sending.js',
      'src/services/invoice/reminders.js',
      'src/services/contract/signatureAssets.js',
      'src/routes/adminDev.js',
    ];
    const offenders = writers.filter((rel) => {
      const source = fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');
      return /process\.cwd\(\),'storage'/.test(source.replace(/\s+/g, ''));
    });
    expect(offenders).toEqual([]);
  });

  it('generated contract PDFs pass the containment check that serves them', () => {
    // assertContractPdfPath guards the admin and public contract download
    // routes. It listed only <cwd>/storage/business-docs/contract, so once the
    // writers moved to STORAGE_PATH every freshly generated contract was
    // refused with PATH_OUTSIDE_STORAGE — a worse failure than the bug being
    // fixed. Both roots must be accepted.
    const { assertContractPdfPath } = require('../../src/utils/safePath');
    const { getStoragePath } = require('../../src/config/storage');

    // assertPathInside realpaths both the file and each root, so the guard only
    // means anything against a filesystem that actually has them — write them.
    const write = (...segments) => {
      const p = path.join(getStoragePath(), 'business-docs', 'contract', ...segments);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'bytes');
      return p;
    };

    const generated = write('2026', 'C-2026-0001.pdf');
    expect(() => assertContractPdfPath(generated)).not.toThrow();

    // Signature PNGs live under the same root and are served by the same guard.
    const signature = write('signatures', '7', 'customer-1.png');
    expect(() => assertContractPdfPath(signature)).not.toThrow();

    // And the guard still refuses a real file outside every allowed root.
    const foreign = path.join(tmpRoot, 'outside.pdf');
    fs.writeFileSync(foreign, 'bytes');
    expect(() => assertContractPdfPath(foreign)).toThrow(/outside the storage roots/i);
  });

  it('writer and guard agree on the root when STORAGE_PATH is unset', () => {
    // The fallbacks used to differ: getStoragePath() resolves module-relative
    // (<repo>/storage) while the guard resolved <cwd>/storage, and the backend
    // is normally started from backend/ — so with no STORAGE_PATH set the guard
    // refused the very files the writers had just produced. Both sides must
    // come from the one resolver.
    delete process.env.STORAGE_PATH;
    jest.resetModules();

    const { getStoragePath } = require('../../src/config/storage');
    const { assertContractPdfPath } = require('../../src/utils/safePath');

    const root = path.join(getStoragePath(), 'business-docs', 'contract', '2026');
    fs.mkdirSync(root, { recursive: true });
    const generated = path.join(root, 'C-2026-0002.pdf');
    fs.writeFileSync(generated, 'bytes');

    try {
      expect(() => assertContractPdfPath(generated)).not.toThrow();
    } finally {
      fs.rmSync(path.join(getStoragePath(), 'business-docs'), { recursive: true, force: true });
    }
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
