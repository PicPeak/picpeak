const crypto = require('crypto');

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const backupManifest = require('../../src/services/backupManifest');
const key = 'a7'.repeat(32);
const clone = value => JSON.parse(JSON.stringify(value));
const base = () => ({
  manifest: { version: '2.0' }, backup: { id: 'test', type: 'full', path: '/backup/point' },
  system: {}, application: {},
  files: { count: 1, manifest: [{ path: 'events/a.jpg', size: 1, checksum: 'b1'.repeat(32) }] },
  database: { type: 'postgresql', backup_file: 'database/dump.sql', checksum: 'c2'.repeat(32) },
  verification: { checksum_algorithm: 'sha256', total_checksum: null },
  metadata: { stored_path_map: { old: 'events/a.jpg' }, stored_path_sha256: { 'events/a.jpg': 'b1'.repeat(32) } },
});

describe('standard manifest authentication defaults', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.BACKUP_MANIFEST_KEY = key;
    delete process.env.BACKUP_MANIFEST_REQUIRE_KEYED;
    delete process.env.BACKUP_MANIFEST_LEGACY_KEY;
    delete process.env.BACKUP_MANIFEST_RECOVERY_SHA256;
    delete process.env.BACKUP_MANIFEST_RECOVERY_REASON;
    delete process.env.BACKUP_MANIFEST_KEYS_OLD;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('rejects attacker-recomputed SHA even without the optional strict flag', () => {
    const manifest = base();
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('rejects an unkeyed downgrade with the normal signing key configured', () => {
    const manifest = base();
    manifest.database.checksum = 'd3'.repeat(32);
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('rejects a keyed declaration when its key was lost', () => {
    const manifest = base();
    manifest.verification.checksum_algorithm = 'hmac-sha256';
    manifest.verification.total_checksum = 'f4'.repeat(32);
    delete process.env.BACKUP_MANIFEST_KEY;
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('never accepts the under-covering legacy serializer, even with strict mode and the key', () => {
    const manifest = base();
    manifest.verification.checksum_algorithm = 'hmac-sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: key, legacy: true });
    manifest.files.manifest[0].checksum = 'e5'.repeat(32);
    manifest.database.backup_file = 'database/replaced.sql';
    process.env.BACKUP_MANIFEST_REQUIRE_KEYED = 'true';
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('fails closed on a missing signature', () => {
    const manifest = base();
    delete manifest.verification.total_checksum;
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('does not allow artifact-supplied recovery authorization', () => {
    const manifest = base();
    manifest.metadata.recovery_reason = 'operator approved';
    manifest.metadata.allow_unauthenticated = true;
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('signs a complete v3 envelope and verifies it with the retained key', () => {
    const manifest = backupManifest.signManifest(base());
    expect(manifest.manifest.version).toBe('3.0');
    expect(manifest.verification.key_id).toBe(crypto.createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex').slice(0, 16));
    expect(backupManifest.verifyManifestChecksum(manifest)).toMatchObject({ valid: true, authenticated: true, recovery: false });
    expect(() => backupManifest.validateManifest(manifest)).not.toThrow();
  });

  it.each([
    ['algorithm', manifest => { manifest.verification.checksum_algorithm = 'sha256'; }],
    ['key identifier', manifest => { manifest.verification.key_id = 'f'.repeat(16); }],
    ['serialization', manifest => { manifest.verification.serialization = 'legacy'; }],
    ['database digest', manifest => { manifest.database.checksum = 'd3'.repeat(32); }],
    ['database path', manifest => { manifest.database.backup_file = 'database/other.sql'; }],
    ['file digest', manifest => { manifest.files.manifest[0].checksum = 'd3'.repeat(32); }],
    ['file path', manifest => { manifest.files.manifest[0].path = 'events/other.jpg'; }],
    ['file metadata', manifest => { manifest.files.manifest[0].permissions = 0o777; }],
    ['stored path mapping', manifest => { manifest.metadata.stored_path_map.old = 'events/other.jpg'; }],
    ['stored path digest', manifest => { manifest.metadata.stored_path_sha256['events/a.jpg'] = 'd3'.repeat(32); }],
    ['backup type', manifest => { manifest.backup.type = 'incremental'; }],
    ['incremental ancestry', manifest => { manifest.incremental = { parent_backup_id: 'other' }; }],
  ])('binds %s to authentication', (_label, mutate) => {
    const manifest = clone(backupManifest.signManifest(base()));
    mutate(manifest);
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('does not accept an attacker-recomputed SHA over a downgraded v3 envelope', () => {
    const manifest = backupManifest.signManifest(base());
    manifest.verification.checksum_algorithm = 'sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('accepts an old v3 key only when retained in the trusted host key ring', () => {
    const manifest = backupManifest.signManifest(base());
    process.env.BACKUP_MANIFEST_KEY = 'e9'.repeat(32);
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
    process.env.BACKUP_MANIFEST_KEYS_OLD = key;
    expect(backupManifest.verifyManifestChecksum(manifest)).toMatchObject({ valid: true, authenticated: true });
  });

  it('supports only explicitly configured canonical pre-v3 HMAC compatibility', () => {
    const manifest = base();
    manifest.verification.checksum_algorithm = 'hmac-sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: key });
    process.env.BACKUP_MANIFEST_KEY = 'e9'.repeat(32);
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
    process.env.BACKUP_MANIFEST_LEGACY_KEY = key;
    expect(backupManifest.verifyManifestChecksum(manifest)).toMatchObject({ valid: true, authenticated: true });
    manifest.files.manifest[0].checksum = 'd3'.repeat(32);
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  // Before v3 any BACKUP_MANIFEST_KEY string was the HMAC key. An upgrade
  // must not strand the backups such a key signed, wherever it is retained.
  it.each([
    ['still in BACKUP_MANIFEST_KEY', 'BACKUP_MANIFEST_KEY'],
    ['moved to BACKUP_MANIFEST_LEGACY_KEY', 'BACKUP_MANIFEST_LEGACY_KEY'],
  ])('verifies a pre-v3 manifest signed with a short passphrase key %s, and never signs with it', (_label, variable) => {
    const passphrase = 'my backup pass';
    const manifest = base();
    manifest.verification.checksum_algorithm = 'hmac-sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: passphrase });
    delete process.env.BACKUP_MANIFEST_KEY;
    process.env[variable] = passphrase;
    expect(backupManifest.verifyManifestChecksum(manifest)).toMatchObject({ valid: true, authenticated: true });
    manifest.files.manifest[0].checksum = 'd3'.repeat(32);
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
    if (variable === 'BACKUP_MANIFEST_KEY') expect(() => backupManifest.signManifest(base())).toThrow(/64 hex digits/);
  });

  it('lets inspection read an intact pre-authentication manifest, flagged, while restore still refuses it', () => {
    const manifest = base();
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    expect(() => backupManifest.validateManifest(manifest)).toThrow(/BACKUP_MANIFEST_RECOVERY_SHA256/);
    expect(() => backupManifest.validateManifest(manifest, { allowRecovery: true })).toThrow(/BACKUP_MANIFEST_RECOVERY_REASON/);
    expect(() => backupManifest.validateManifest(manifest, { inspect: true })).not.toThrow();
    expect(backupManifest.getAuthentication(manifest)).toMatchObject({ valid: false, authenticated: false, legacy: true });
  });

  it('does not let inspection read a damaged or downgraded manifest as legacy', () => {
    const damaged = base();
    damaged.verification.total_checksum = backupManifest.calculateManifestChecksum(damaged, { keyed: false });
    damaged.files.manifest[0].path = 'events/other.jpg';
    expect(() => backupManifest.validateManifest(damaged, { inspect: true })).toThrow(/not authenticated/);
    const downgraded = backupManifest.signManifest(base());
    downgraded.verification.checksum_algorithm = 'sha256';
    downgraded.verification.total_checksum = backupManifest.calculateManifestChecksum(downgraded, { keyed: false });
    expect(() => backupManifest.validateManifest(downgraded, { inspect: true })).toThrow(/not authenticated/);
  });

  it('never enables the legacy under-covering serializer in compatibility mode', () => {
    const manifest = base();
    manifest.verification.checksum_algorithm = 'hmac-sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: key, legacy: true });
    process.env.BACKUP_MANIFEST_LEGACY_KEY = key;
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
  });

  it('requires a host-approved complete artifact digest and meaningful reason for unauthenticated recovery', () => {
    const manifest = base();
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    const { recoveryDigest } = require('../../src/utils/manifestCanonical');
    process.env.BACKUP_MANIFEST_RECOVERY_SHA256 = recoveryDigest(manifest);
    process.env.BACKUP_MANIFEST_RECOVERY_REASON = 'Host operator inspected legacy backup before recovery';
    expect(backupManifest.verifyManifestChecksum(manifest).valid).toBe(false);
    expect(backupManifest.verifyManifestChecksum(manifest, { allowRecovery: true })).toMatchObject({ valid: true, authenticated: false, recovery: true });
    manifest.files.manifest[0].checksum = 'd3'.repeat(32);
    expect(backupManifest.verifyManifestChecksum(manifest, { allowRecovery: true }).valid).toBe(false);
  });

  it.each(['', 'yes', 'f'.repeat(64)])('rejects invalid or non-matching host approval %s', approval => {
    process.env.BACKUP_MANIFEST_RECOVERY_SHA256 = approval;
    process.env.BACKUP_MANIFEST_RECOVERY_REASON = 'Approved legacy backup recovery by host operator';
    expect(backupManifest.verifyManifestChecksum(base(), { allowRecovery: true }).valid).toBe(false);
  });
});
