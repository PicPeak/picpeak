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
    const fchmod = jest.spyOn(fs, 'fchmodSync').mockImplementation(() => {});
    try { expect(() => loadKey({ create: true })).toThrow(/group- or world-writable/); } finally { fchmod.mockRestore(); }
    expect(fs.readFileSync(file, 'utf8')).toBe('a9'.repeat(32));
    fs.unlinkSync(file);
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'a9'.repeat(32), { mode: 0o600 });
    fs.symlinkSync(target, file);
    expect(() => loadKey({ create: true })).toThrow();
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('restricts a group/world-writable key file it owns to 0600 and uses it', () => {
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'a9'.repeat(32));
    fs.chmodSync(file, 0o666);
    const warn = jest.spyOn(require('../../src/utils/logger'), 'warn').mockImplementation(() => {});
    try {
      expect(loadKey({ create: true }).key).toEqual(Buffer.from('a9'.repeat(32), 'hex'));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(warn.mock.calls.some(([message]) => String(message).includes(file) && /0666.*0600/.test(message))).toBe(true);
    } finally { warn.mockRestore(); }
    expect(keyStatus()).toMatchObject({ ready: true, source: 'file' });
  });

  // A NAS / VM shared folder / bind mount that reports 0777 whatever chmod says.
  const ignoreModes = () => {
    const realFstat = fs.fstatSync;
    return [
      jest.spyOn(fs, 'fchmodSync').mockImplementation(() => {}),
      jest.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
        const stat = realFstat(...args);
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: (stat.mode & ~0o777) | 0o777 });
      }),
    ];
  };

  it('refuses a key whose mode does not stick, naming the file, its mode and the fixes', () => {
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'a9'.repeat(32), { mode: 0o600 });
    const spies = ignoreModes();
    try {
      let message;
      try { loadKey({ create: true }); } catch (error) { message = error.message; }
      expect(message).toContain(file);
      expect(message).toContain('mode 0777');
      expect(message).toMatch(/does not keep file modes/);
      expect(message).toMatch(/BACKUP_MANIFEST_KEY_FILE/);
      expect(message).toMatch(/BACKUP_MANIFEST_KEY to its 64 hex digits/);
      expect(message).not.toContain('a9'.repeat(32));
      expect(keyStatus()).toEqual({ ready: false, source: 'invalid', keyId: null, reason: message });
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });

  it('tells the owner to chmod a writable key file it does not own, and leaves it alone', () => {
    if (typeof process.getuid !== 'function') return;
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'a9'.repeat(32));
    fs.chmodSync(file, 0o666);
    const realFstat = fs.fstatSync;
    const fchmod = jest.spyOn(fs, 'fchmodSync');
    const fstat = jest.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
      const stat = realFstat(...args);
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: process.getuid() + 1 });
    });
    try {
      expect(() => loadKey()).toThrow(`chmod 600 ${file}`);
      expect(fchmod).not.toHaveBeenCalled();
    } finally { fchmod.mockRestore(); fstat.mockRestore(); }
  });

  it('stops at creation when the new key file does not keep 0600, not later at signing', () => {
    const spies = ignoreModes();
    try {
      expect(() => loadKey({ create: true })).toThrow(/does not keep file modes/);
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });

  it('selects retained keys by nonsecret identifier and rejects malformed ring entries', () => {
    process.env.BACKUP_MANIFEST_KEY = 'a9'.repeat(32);
    process.env.BACKUP_MANIFEST_KEYS_OLD = 'b8'.repeat(32);
    expect(keyRing().size).toBe(2);
    expect(keyRing().get(idOf(Buffer.from('b8'.repeat(32), 'hex')))).toEqual(Buffer.from('b8'.repeat(32), 'hex'));
    process.env.BACKUP_MANIFEST_KEYS_OLD = 'broken';
    expect(() => keyRing()).toThrow(/BACKUP_MANIFEST_KEYS_OLD/);
  });

  it('keeps retained keys verifiable when the current key is unusable, while signing still fails', () => {
    const old = Buffer.from('b8'.repeat(32), 'hex');
    process.env.BACKUP_MANIFEST_KEYS_OLD = 'b8'.repeat(32);
    process.env.BACKUP_MANIFEST_KEY = 'broken';
    expect(keyRing().get(idOf(old))).toEqual(old);
    expect(() => loadKey({ create: true })).toThrow(/64 hex digits/);
    delete process.env.BACKUP_MANIFEST_KEY;
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'a9'.repeat(32), { mode: 0o600 });
    const spies = ignoreModes();
    try {
      expect(Array.from(keyRing().keys())).toEqual([idOf(old)]);
      expect(() => loadKey({ create: true })).toThrow(/does not keep file modes/);
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });

  it('publishes a new key only once its bytes are on disk, and leaves no temporary file', () => {
    const file = keyFile();
    const realLink = fs.linkSync;
    const link = jest.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      expect(to).toBe(file);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readFileSync(from, 'utf8')).toMatch(/^[a-f0-9]{64}$/);
      return realLink(from, to);
    });
    try {
      const { key } = loadKey({ create: true });
      expect(link).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(file, 'utf8')).toBe(key.toString('hex'));
    } finally { link.mockRestore(); }
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the key another process published first, and creates directly where hard links are unsupported', () => {
    const file = keyFile();
    const realLink = fs.linkSync;
    let link = jest.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      fs.writeFileSync(to, 'c7'.repeat(32), { mode: 0o600 });
      return realLink(from, to);
    });
    try {
      expect(loadKey({ create: true }).key).toEqual(Buffer.from('c7'.repeat(32), 'hex'));
    } finally { link.mockRestore(); }
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    fs.unlinkSync(file);
    link = jest.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    try {
      const { key } = loadKey({ create: true });
      expect(fs.readFileSync(file, 'utf8')).toBe(key.toString('hex'));
    } finally { link.mockRestore(); }
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('leaves neither a key nor a temporary file behind when writing the new key fails', () => {
    const file = keyFile();
    const realWrite = fs.writeFileSync;
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
      if (typeof target === 'number') throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return realWrite(target, ...rest);
    });
    try {
      expect(() => loadKey({ create: true })).toThrow(/no space left/);
    } finally { write.mockRestore(); }
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it('removes its own half-written key where hard links are unsupported and the write fails', () => {
    const file = keyFile();
    const realWrite = fs.writeFileSync;
    let writes = 0;
    const link = jest.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not supported'), { code: 'EOPNOTSUPP' });
    });
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
      if (typeof target === 'number' && ++writes === 2) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return realWrite(target, ...rest);
    });
    try {
      expect(() => loadKey({ create: true })).toThrow(/no space left/);
    } finally { link.mockRestore(); write.mockRestore(); }
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
    expect(loadKey({ create: true }).key.length).toBe(32);
  });

  it('does not wait on a key file that has stayed short', () => {
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const read = jest.spyOn(fs, 'readFileSync');
    try {
      expect(() => keyRing()).not.toThrow();
      expect(() => loadKey()).toThrow(/64 hex digits/);
      expect(read.mock.calls.filter(([target]) => typeof target === 'number')).toHaveLength(2);
    } finally { read.mockRestore(); }
  });

  it('warns, without failing, when another account could replace the key through its directory', () => {
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'a9'.repeat(32), { mode: 0o600 });
    const warn = jest.spyOn(require('../../src/utils/logger'), 'warn').mockImplementation(() => {});
    const dirWarnings = () => warn.mock.calls.map(([message]) => String(message)).filter(message => /directory/.test(message));
    try {
      loadKey();
      expect(dirWarnings()).toHaveLength(0);
      fs.chmodSync(path.dirname(file), 0o1777);
      loadKey();
      expect(dirWarnings()).toHaveLength(0);
      fs.chmodSync(path.dirname(file), 0o777);
      expect(loadKey().key).toEqual(Buffer.from('a9'.repeat(32), 'hex'));
      expect(keyStatus()).toMatchObject({ ready: true, source: 'file' });
      const messages = dirWarnings();
      // Said once per directory state, not on every backup and health check.
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(path.dirname(file));
      expect(messages[0]).toContain('0777');
      expect(messages[0]).not.toContain('a9'.repeat(32));
    } finally { warn.mockRestore(); fs.chmodSync(path.dirname(file), 0o700); }
  });

  it('waits briefly for the bytes of a key file another process has just created', () => {
    const file = keyFile();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '', { mode: 0o600 });
    // Another process created the file exclusively; its bytes land while we read.
    const realRead = fs.readFileSync;
    let reads = 0;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (typeof args[0] === 'number' && ++reads === 2) fs.writeFileSync(file, 'd6'.repeat(32));
      return realRead(...args);
    });
    try {
      expect(loadKey({ create: true }).key).toEqual(Buffer.from('d6'.repeat(32), 'hex'));
    } finally { read.mockRestore(); }
  });
});
