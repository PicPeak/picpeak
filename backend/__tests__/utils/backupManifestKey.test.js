const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadKey, keyRing, keyStatus, idOf, keyFile } = require('../../src/utils/backupManifestKey');

describe('backup manifest trust anchor', () => {
  const saved = { ...process.env };
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-manifest-key-'));
    delete process.env.BACKUP_MANIFEST_KEY;
    delete process.env.BACKUP_MANIFEST_KEYS_OLD;
    process.env.DATA_DIR = path.join(dir, 'data');
    process.env.STORAGE_PATH = path.join(dir, 'storage');
    process.env.BACKUP_MANIFEST_KEY_FILE = path.join(dir, 'secrets', 'manifest.key');
    fs.mkdirSync(process.env.STORAGE_PATH);
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('verification and health do not generate a replacement key when the retained key is absent', () => {
    expect(keyStatus()).toEqual({ ready: false, source: 'missing', keyId: null });
    expect(() => loadKey()).toThrow();
    expect(keyRing().size).toBe(0);
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it('creates and persists 32 random bytes exclusively outside the file estate', () => {
    const first = loadKey({ create: true });
    const second = loadKey({ create: true });
    expect(first.key.length).toBe(32);
    expect(second.key).toEqual(first.key);
    expect(first.keyId).toBe(idOf(first.key));
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(keyFile())).mode & 0o777).toBe(0o700);
    expect(keyStatus()).toEqual({ ready: true, source: 'file', keyId: first.keyId });
    expect(JSON.stringify(keyStatus())).not.toContain(first.key.toString('hex'));
  });

  it('says once, when it creates the key, that it must be kept off the host with the backups', () => {
    const warn = jest.spyOn(require('../../src/utils/logger'), 'warn').mockImplementation(() => {});
    try {
      const { key } = loadKey({ create: true });
      loadKey({ create: true });
      const messages = warn.mock.calls.map(([message]) => String(message)).filter(message => /signing key/.test(message));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/OFF this host/);
      expect(messages[0]).toMatch(/whoever keeps the backups/);
      expect(messages[0]).toContain(keyFile());
      expect(messages[0]).not.toContain(key.toString('hex'));
    } finally { warn.mockRestore(); }
  });

  it('uses a strict configured 32-byte key without writing a file', () => {
    process.env.BACKUP_MANIFEST_KEY = 'e7'.repeat(32);
    expect(loadKey().key).toEqual(Buffer.from(process.env.BACKUP_MANIFEST_KEY, 'hex'));
    expect(loadKey().source).toBe('env');
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it.each(['short', 'a'.repeat(63), 'z'.repeat(64), 'a'.repeat(65), 'password'.repeat(8)])('fails closed on malformed configured key %s', value => {
    process.env.BACKUP_MANIFEST_KEY = value;
    expect(() => loadKey({ create: true })).toThrow(/64 hex digits/);
    expect(keyStatus().ready).toBe(false);
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it('uses DATA_DIR rather than managed storage for a native default', () => {
    delete process.env.BACKUP_MANIFEST_KEY_FILE;
    // The CI/native fixture has no Compose secrets mount.
    if (fs.existsSync('/run/secrets/backup_manifest_key')) return;
    expect(keyFile()).toBe(path.join(process.env.DATA_DIR, 'backup-manifest.key'));
    expect(loadKey({ create: true }).source).toBe('file');
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'backup-manifest.key'))).toBe(false);
  });

  it('refuses explicit and symlink-aliased paths inside backed-up storage', () => {
    process.env.BACKUP_MANIFEST_KEY_FILE = path.join(process.env.STORAGE_PATH, 'key');
    expect(() => loadKey({ create: true })).toThrow(/outside the backed-up storage estate/);
    fs.symlinkSync(process.env.STORAGE_PATH, path.join(dir, 'linked-storage'));
    process.env.BACKUP_MANIFEST_KEY_FILE = path.join(dir, 'linked-storage', 'keys', 'key');
    expect(() => loadKey({ create: true })).toThrow(/outside the backed-up storage estate/);
    expect(fs.readdirSync(process.env.STORAGE_PATH)).toEqual([]);
  });

  it('never regenerates an invalid, writable or symlinked existing key', () => {
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'invalid', { mode: 0o600 });
    expect(() => loadKey({ create: true })).toThrow(/64 hex digits/);
    expect(fs.readFileSync(file, 'utf8')).toBe('invalid');
    fs.writeFileSync(file, 'a9'.repeat(32));
    fs.chmodSync(file, 0o666);
    expect(() => loadKey({ create: true })).toThrow(/non-group\/world-writable/);
    fs.unlinkSync(file);
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'a9'.repeat(32), { mode: 0o600 });
    fs.symlinkSync(target, file);
    expect(() => loadKey({ create: true })).toThrow();
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('selects retained keys by nonsecret identifier and rejects malformed ring entries', () => {
    process.env.BACKUP_MANIFEST_KEY = 'a9'.repeat(32);
    process.env.BACKUP_MANIFEST_KEYS_OLD = 'b8'.repeat(32);
    expect(keyRing().size).toBe(2);
    expect(keyRing().get(idOf(Buffer.from('b8'.repeat(32), 'hex')))).toEqual(Buffer.from('b8'.repeat(32), 'hex'));
    process.env.BACKUP_MANIFEST_KEYS_OLD = 'broken';
    expect(() => keyRing()).toThrow(/BACKUP_MANIFEST_KEYS_OLD/);
  });
});
