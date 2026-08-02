/**
 * Backup/restore hardening — GHSA-h652 (unbounded gunzip) and GHSA-hgp8
 * (unkeyed manifest checksum).
 *
 * h652: decompressFile() piped gunzip straight to disk with no expanded-size
 * bound, so a small crafted .gz could fill the volume.
 *
 * hgp8: the manifest checksum is a plain SHA-256 — it proves the manifest was
 * not corrupted, not that it is authentic. BACKUP_MANIFEST_KEY upgrades new
 * manifests to a keyed HMAC. It is deliberately OPT-IN and verify-if-present:
 * the key cannot live in the database (the database is inside the backup), so
 * a mandatory HMAC would lock an operator out of the exact disaster-recovery
 * case this system exists for.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-bkharden-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bkharden-test-secret';

const { restoreService } = require('../../src/services/restoreService');
const backupManifest = require('../../src/services/backupManifest');

describe('decompressFile expanded-size bound (GHSA-h652)', () => {
  let dir;

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-gz-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => { delete process.env.RESTORE_MAX_DECOMPRESSED_BYTES; });

  it('aborts when the decompressed stream exceeds the limit', async () => {
    // 5 MB of zeroes compresses to a few KB — the classic shape of the attack.
    const gzPath = path.join(dir, 'bomb.gz');
    fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 0)));

    process.env.RESTORE_MAX_DECOMPRESSED_BYTES = String(64 * 1024); // 64 KB
    await expect(
      restoreService.decompressFile(gzPath, path.join(dir, 'out-bomb'))
    ).rejects.toThrow(/exceeds limit/i);
  });

  it('still decompresses a normal file within the limit', async () => {
    const payload = Buffer.from('SELECT 1;\n'.repeat(100));
    const gzPath = path.join(dir, 'ok.gz');
    fs.writeFileSync(gzPath, zlib.gzipSync(payload));

    const outPath = path.join(dir, 'out-ok');
    await restoreService.decompressFile(gzPath, outPath);
    expect(fs.readFileSync(outPath)).toEqual(payload);
  });
});

describe('manifest checksum keying (GHSA-hgp8)', () => {
  // validateManifest requires all of these sections to be present.
  const baseManifest = () => ({
    manifest: { version: '1.0', id: 'test' },
    backup: { type: 'full' },
    system: { platform: 'linux' },
    application: { version: '1.0.0' },
    files: { count: 1, manifest: [{ path: 'a.jpg', size: 1 }] },
    database: { type: 'sqlite' },
    verification: { total_checksum: null, checksum_algorithm: null },
  });

  afterEach(() => { delete process.env.BACKUP_MANIFEST_KEY; });

  it('produces a different digest when a key is set', () => {
    const m = baseManifest();
    const unkeyed = backupManifest.calculateManifestChecksum(m, { keyed: false });
    const keyed = backupManifest.calculateManifestChecksum(m, { keyed: 'secret-key' });
    expect(keyed).not.toBe(unkeyed);
  });

  it('validates a legacy unkeyed manifest even when a key IS configured', () => {
    // Disaster recovery: manifests written before keying must not become
    // un-restorable the moment the operator sets a key.
    const m = baseManifest();
    m.verification.checksum_algorithm = 'sha256';
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: false });

    process.env.BACKUP_MANIFEST_KEY = 'secret-key';
    expect(() => backupManifest.validateManifest(m)).not.toThrow();
  });

  it('accepts a keyed manifest when the matching key is configured', () => {
    process.env.BACKUP_MANIFEST_KEY = 'secret-key';
    const m = baseManifest();
    m.verification.checksum_algorithm = 'hmac-sha256';
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: 'secret-key' });

    expect(() => backupManifest.validateManifest(m)).not.toThrow();
  });

  it('rejects a keyed manifest whose body was tampered with', () => {
    process.env.BACKUP_MANIFEST_KEY = 'secret-key';
    const m = baseManifest();
    m.verification.checksum_algorithm = 'hmac-sha256';
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: 'secret-key' });

    m.files.manifest[0].path = '../../etc/passwd';
    expect(() => backupManifest.validateManifest(m)).toThrow(/checksum verification failed/i);
  });

  it('does NOT brick restore when a keyed manifest meets a missing key', () => {
    // Key lost with the host — the precise moment a restore is needed.
    const m = baseManifest();
    m.verification.checksum_algorithm = 'hmac-sha256';
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: 'secret-key' });

    delete process.env.BACKUP_MANIFEST_KEY;
    expect(() => backupManifest.validateManifest(m)).not.toThrow();
  });
});

describe('manifest checksum coverage (canonicalization)', () => {
  const fullManifest = () => ({
    manifest: { version: '1.0', id: 'test' },
    backup: { type: 'full' },
    system: { platform: 'linux' },
    application: { version: '1.0.0' },
    files: { count: 1, manifest: [{ path: 'a.jpg', size: 1 }] },
    database: { type: 'sqlite' },
    verification: { total_checksum: null, checksum_algorithm: 'sha256' },
  });

  afterEach(() => { delete process.env.BACKUP_MANIFEST_KEY; });

  it('covers nested file entries (the old replacer dropped them)', () => {
    const m = fullManifest();
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: false });
    // Tampering a file path must now change the digest.
    m.files.manifest[0].path = '../../etc/passwd';
    expect(() => backupManifest.validateManifest(m)).toThrow(/checksum verification failed/i);
  });

  it('still accepts a manifest written with the legacy serialization', () => {
    const m = fullManifest();
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(
      m, { keyed: false, legacy: true }
    );
    expect(() => backupManifest.validateManifest(m)).not.toThrow();
  });
});

describe('checksum verification is shared and downgrade-aware (codex round 2)', () => {
  const fullManifest = () => ({
    manifest: { version: '1.0', id: 'test' },
    backup: { type: 'full' },
    system: { platform: 'linux' },
    application: { version: '1.0.0' },
    files: { count: 1, manifest: [{ path: 'a.jpg', size: 1 }] },
    database: { type: 'sqlite' },
    verification: { total_checksum: null, checksum_algorithm: 'sha256' },
  });

  afterEach(() => {
    delete process.env.BACKUP_MANIFEST_KEY;
    delete process.env.BACKUP_MANIFEST_REQUIRE_KEYED;
  });

  it('accepts a legacy-serialized manifest through the SHARED verifier', () => {
    // restoreService recomputed the digest itself with the canonical
    // serializer, which rejected every pre-existing backup.
    const m = fullManifest();
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(
      m, { keyed: false, legacy: true },
    );
    const res = backupManifest.verifyManifestChecksum(m);
    expect(res.valid).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/legacy checksum serialization/i);
  });

  it('warns but accepts an unkeyed manifest when a key is configured', () => {
    const m = fullManifest();
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: false });
    process.env.BACKUP_MANIFEST_KEY = 'secret-key';

    const res = backupManifest.verifyManifestChecksum(m);
    expect(res.valid).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/authenticity NOT established/i);
  });

  it('REJECTS the algorithm downgrade once REQUIRE_KEYED is on', () => {
    // Attacker rewrites the manifest, strips checksum_algorithm and recomputes
    // a plain SHA-256. With the strict flag set that must not verify.
    const m = fullManifest();
    m.files.manifest[0].path = '../../etc/passwd';
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: false });

    process.env.BACKUP_MANIFEST_KEY = 'secret-key';
    process.env.BACKUP_MANIFEST_REQUIRE_KEYED = 'true';

    const res = backupManifest.verifyManifestChecksum(m);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/downgrade/i);
  });

  it('rejects a keyed manifest with no key when REQUIRE_KEYED is on', () => {
    const m = fullManifest();
    m.verification.checksum_algorithm = 'hmac-sha256';
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: 'k' });
    process.env.BACKUP_MANIFEST_REQUIRE_KEYED = 'true';

    expect(backupManifest.verifyManifestChecksum(m).valid).toBe(false);
  });

  it('REJECTS a manifest whose checksum was stripped entirely', () => {
    // The cheapest bypass of every rule above: delete the field instead of
    // forging it. Both the helper's early return and restoreService's
    // `if (…total_checksum)` guard used to wave that through.
    const m = fullManifest();
    delete m.verification.total_checksum;

    const res = backupManifest.verifyManifestChecksum(m);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/no checksum/i);

    delete m.verification;
    expect(backupManifest.verifyManifestChecksum(m).valid).toBe(false);
  });

  it('REJECTS an unkeyed manifest under REQUIRE_KEYED even with no key configured', () => {
    // Strict mode is a claim about the manifests, not about this host — so a
    // fresh disaster-recovery box that lost BACKUP_MANIFEST_KEY must not
    // silently start accepting plain SHA-256 manifests again.
    const m = fullManifest();
    m.verification.total_checksum = backupManifest.calculateManifestChecksum(m, { keyed: false });
    process.env.BACKUP_MANIFEST_REQUIRE_KEYED = 'true';
    delete process.env.BACKUP_MANIFEST_KEY;

    const res = backupManifest.verifyManifestChecksum(m);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/downgrade/i);
  });
});
