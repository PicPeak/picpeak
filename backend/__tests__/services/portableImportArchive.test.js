'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const archiver = require('archiver');
const {
  HARD_LIMITS, openBoundedArchive, assertArchiveWithinLimits, extractWithinLimits, readEntryWithin,
} = require('../../src/services/portableImportArchive');

const ENV = ['PICPEAK_IMPORT_MAX_ENTRIES', 'PICPEAK_IMPORT_MAX_EXPANDED_BYTES', 'PICPEAK_IMPORT_MAX_MANIFEST_BYTES'];
const available = { type: 0xef53n, bsize: 4096n, bavail: 1024n * 1024n, ffree: 1024n * 1024n };
const validateFileKey = key => key.startsWith('business-docs/') && !key.startsWith('business-docs/.picpeak-maintenance/') ? null : 'not exported';
let fixture;
let workspace;
let originals;

async function archive(entries, zip64 = false) {
  const file = path.join(fixture, `archive-${Math.random()}.picpeak`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const zip = archiver('zip', { forceZip64: zip64 });
    zip.on('error', reject);
    output.on('error', reject);
    output.on('close', resolve);
    zip.pipe(output);
    for (const [name, content] of entries) zip.append(content, { name });
    zip.finalize();
  });
  return file;
}

// A real descriptor archive whose central and local sizes understate the
// inflated data. This exercises the same representation as the prior importer.
async function crafted(entries) {
  const file = path.join(fixture, `crafted-${Math.random()}.picpeak`);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const options of entries) {
    const { name, content = Buffer.from('x'), extra = Buffer.alloc(0), comment = Buffer.alloc(0), attr = 0,
      declared = 1, method = 8, compressed = null, flags = 8, crc = 0 } = options;
    const nameBytes = Buffer.isBuffer(name) ? name : Buffer.from(name);
    const data = compressed || (method === 8 ? zlib.deflateRawSync(content) : content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(declared, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(comment.length, 32);
    header.writeUInt32LE(attr, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes, extra, comment);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await fsp.writeFile(file, Buffer.concat([...parts, directory, end]), { mode: 0o600 });
  return file;
}

async function open(file, options = {}) {
  return openBoundedArchive(file, { validateFileKey, persistentRoot: fixture, ...options });
}

beforeEach(async () => {
  originals = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
  ENV.forEach(name => delete process.env[name]);
  fixture = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-zip-budget-')));
  workspace = path.join(fixture, 'workspace');
  await fsp.mkdir(workspace, { mode: 0o700 });
  // Linux uses real measured capacity. macOS is only a development machine;
  // its filesystem is not part of the production local-filesystem contract.
  if (process.platform !== 'linux') jest.spyOn(fsp, 'statfs').mockResolvedValue(available);
});

afterEach(async () => {
  for (const name of ENV) {
    if (originals[name] === undefined) delete process.env[name];
    else process.env[name] = originals[name];
  }
  jest.restoreAllMocks();
  await fsp.rm(fixture, { recursive: true, force: true });
});

describe('bounded portable archive enumeration', () => {
  it.each([false, true])('preserves genuine archives, Unicode, empty rows and legacy uncatalogued files (ZIP64=%s)', async zip64 => {
    const file = await archive([
      ['manifest.json', '{"kind":"picpeak-backup","format":1}'],
      ['data/admin_users.ndjson', '{"id":1}\r\n'],
      ['data/obsolete_table.ndjson', ''],
      ['files/business-docs/Grüße.txt', 'ordinary bytes'],
    ], zip64);
    const zip = await open(file, { allowedTables: new Set(['admin_users']) });
    try {
      const entries = Object.values(await zip.entries());
      expect(Object.getPrototypeOf(await zip.entries())).toBeNull();
      expect((await zip.entry('data/obsolete_table.ndjson')).ignoredTable).toBe(true);
      expect(JSON.parse((await readEntryWithin(zip, 'manifest.json', HARD_LIMITS.manifestBytes)).toString())).toMatchObject({ format: 1 });
      expect(await extractWithinLimits(zip, entries, workspace)).toEqual({ expandedBytes: 60 });
      expect(await fsp.readFile(path.join(workspace, 'files/business-docs/Grüße.txt'), 'utf8')).toBe('ordinary bytes');
      expect((await fsp.stat(path.join(workspace, 'data/obsolete_table.ndjson'))).mode & 0o777).toBe(0o600);
      expect((await fsp.stat(path.join(workspace, 'files/business-docs'))).mode & 0o777).toBe(0o700);
    } finally { await zip.close(); await zip.close(); }
  });

  it('refuses count during enumeration and closes the raw descriptor before rejecting', async () => {
    const file = await archive([['manifest.json', '{}'], ['data/a.ndjson', '{}'], ['data/b.ndjson', '{}']]);
    process.env.PICPEAK_IMPORT_MAX_ENTRIES = '2';
    const close = jest.spyOn(fs, 'close');
    await expect(open(file)).rejects.toMatchObject({ statusCode: 413 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => fs.fstatSync(close.mock.calls[0][0])).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  it.each([
    ['duplicate', [{ name: 'manifest.json' }, { name: 'manifest.json' }]],
    ['file/directory collision', [{ name: 'manifest.json' }, { name: 'files/business-docs/a' }, { name: 'files/business-docs/a/b.txt' }]],
    ['reverse collision', [{ name: 'manifest.json' }, { name: 'files/business-docs/a/b.txt' }, { name: 'files/business-docs/a' }]],
    ['traversal', [{ name: 'manifest.json' }, { name: 'data/../secret.ndjson' }]],
    ['control character', [{ name: 'manifest.json' }, { name: 'files/business-docs/a\n.txt' }]],
    ['invalid UTF8', [{ name: 'manifest.json' }, { name: Buffer.from([0xff]) }]],
    ['unsupported layout', [{ name: 'manifest.json' }, { name: 'database.sql' }]],
    ['unsupported file', [{ name: 'manifest.json' }, { name: 'files/.picpeak-maintenance/private' }]],
    ['symlink', [{ name: 'manifest.json' }, { name: 'files/business-docs/link', attr: 0o120777 << 16 }]],
    ['long name', [{ name: 'manifest.json' }, { name: `files/business-docs/${'x'.repeat(1024)}` }]],
  ])('refuses %s before extraction', async (_label, entries) => {
    // Unsigned external attributes, as encoded by real ZIP headers.
    entries = entries.map(entry => ({ ...entry, attr: (entry.attr || 0) >>> 0 }));
    await expect(open(await crafted(entries))).rejects.toMatchObject({ statusCode: 400 });
    expect(await fsp.readdir(workspace)).toEqual([]);
  });

  it('refuses aggregate central metadata while enumeration is still in progress', async () => {
    const file = await crafted([
      { name: 'manifest.json' },
      ...Array.from({ length: 257 }, (_, index) => ({ name: `data/t${index}.ndjson`, comment: Buffer.alloc(65535, 65) })),
    ]);
    await expect(open(file)).rejects.toMatchObject({ statusCode: 413 });
  });

  it('never permits environment settings to enlarge hard ceilings', async () => {
    process.env.PICPEAK_IMPORT_MAX_ENTRIES = String(HARD_LIMITS.entries * 10);
    process.env.PICPEAK_IMPORT_MAX_EXPANDED_BYTES = String(HARD_LIMITS.expandedBytes * 10);
    process.env.PICPEAK_IMPORT_MAX_MANIFEST_BYTES = String(HARD_LIMITS.manifestBytes * 10);
    const file = await crafted([{ name: 'manifest.json', declared: HARD_LIMITS.manifestBytes + 1 }]);
    await expect(open(file)).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertArchiveWithinLimits([{ name: 'data/a.ndjson', size: HARD_LIMITS.expandedBytes + 1 }], workspace))
      .rejects.toMatchObject({ statusCode: 413 });
    await expect(assertArchiveWithinLimits(Array.from({ length: HARD_LIMITS.entries + 1 }, (_, i) => ({ name: `data/t${i}.ndjson`, size: 0 })), workspace))
      .rejects.toMatchObject({ statusCode: 413 });
  });

  it('refuses archive source symlinks and hardlinks', async () => {
    const file = await archive([['manifest.json', '{}']]);
    const alias = path.join(fixture, 'alias.picpeak');
    await fsp.symlink(file, alias);
    await expect(open(alias)).rejects.toMatchObject({ statusCode: 400 });
    await fsp.unlink(alias);
    await fsp.link(file, alias);
    await expect(open(file)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('closes a malformed archive during initial enumeration and preserves existing files', async () => {
    const file = path.join(fixture, 'not-a-zip.picpeak');
    await fsp.writeFile(file, 'not a zip');
    const close = jest.spyOn(fs, 'close');
    await expect(open(file)).rejects.toMatchObject({ statusCode: 400 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => fs.fstatSync(close.mock.calls[0][0])).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(await fsp.readFile(file, 'utf8')).toBe('not a zip');
  });

  it('refuses a source modified after enumeration and closes safely', async () => {
    const file = await archive([['manifest.json', '{}']]);
    const zip = await open(file);
    try {
      await fsp.appendFile(file, 'changed');
      await expect(zip.stream('manifest.json')).rejects.toMatchObject({ statusCode: 400 });
    } finally { await zip.close(); }
  });

  it.each([0, 8])('preserves checksum-verified entries without data descriptors (method=%s)', async method => {
    const content = Buffer.from('{"kind":"picpeak-backup"}');
    const file = await crafted([{ name: 'manifest.json', content, method, flags: 0, declared: content.length, crc: zlib.crc32(content) }]);
    const zip = await open(file);
    try { expect(await readEntryWithin(zip, 'manifest.json', 100)).toEqual(content); }
    finally { await zip.close(); }
  });

  it('refuses checksum corruption when descriptor flags do not disable verification', async () => {
    const file = await crafted([{ name: 'manifest.json', content: Buffer.from('{}'), method: 0, flags: 0, declared: 2, crc: 123 }]);
    const zip = await open(file);
    try { await expect(readEntryWithin(zip, 'manifest.json', 100)).rejects.toMatchObject({ statusCode: 400 }); }
    finally { await zip.close(); }
  });
});

describe('bounded actual expansion and measured workspace capacity', () => {
  it('bounds real manifest bytes despite descriptor headers declaring one byte', async () => {
    const file = await crafted([{ name: 'manifest.json', content: Buffer.alloc(2 * 1024 * 1024, 65) }]);
    process.env.PICPEAK_IMPORT_MAX_MANIFEST_BYTES = '100';
    const zip = await open(file);
    try {
      await expect(readEntryWithin(zip, 'manifest.json', HARD_LIMITS.manifestBytes, () => Object.assign(new Error('too large'), { statusCode: 400 })))
        .rejects.toMatchObject({ statusCode: 400 });
    } finally { await zip.close(); }
  });

  it('counts real inflated bytes before writing and removes only its own partial leaf', async () => {
    const file = await crafted([{ name: 'manifest.json', content: Buffer.from('{}') },
      { name: 'data/big.ndjson', content: Buffer.alloc(2 * 1024 * 1024, 65) }]);
    process.env.PICPEAK_IMPORT_MAX_EXPANDED_BYTES = '100';
    const zip = await open(file);
    try {
      const entries = Object.values(await zip.entries());
      await expect(assertArchiveWithinLimits(entries, workspace)).resolves.toEqual({ entries: 2, expandedBytes: 2 });
      await expect(extractWithinLimits(zip, entries, workspace)).rejects.toMatchObject({ statusCode: 413 });
      await expect(fsp.stat(path.join(workspace, 'data/big.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fsp.readFile(path.join(workspace, 'manifest.json'), 'utf8')).toBe('{}');
    } finally { await zip.close(); }
  });

  it.each([
    ['missing capacity', {}],
    ['nonfinite capacity', { ...available, bavail: Infinity }],
    ['zero block size', { ...available, bsize: 0n }],
    ['exhausted bytes', { ...available, bavail: 1n }],
    ['exhausted inodes', { ...available, ffree: 1n }],
    ['unknown filesystem', { ...available, type: 12345n }],
    ['network filesystem', { ...available, type: 0x6969n }],
  ])('refuses %s rather than treating it as unlimited space', async (_label, stats) => {
    jest.spyOn(fsp, 'statfs').mockResolvedValue(stats);
    await expect(assertArchiveWithinLimits([{ name: 'manifest.json', size: 2 }], workspace)).rejects.toMatchObject({ statusCode: 507 });
    expect(await fsp.readdir(workspace)).toEqual([]);
  });

  it('refuses an unavailable statfs API', async () => {
    const old = fsp.statfs;
    fsp.statfs = undefined;
    try { await expect(assertArchiveWithinLimits([{ name: 'manifest.json', size: 2 }], workspace)).rejects.toMatchObject({ statusCode: 507 }); }
    finally { fsp.statfs = old; }
  });

  it('refuses a failing statfs measurement', async () => {
    jest.spyOn(fsp, 'statfs').mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EIO' }));
    await expect(assertArchiveWithinLimits([{ name: 'manifest.json', size: 2 }], workspace)).rejects.toMatchObject({ statusCode: 507 });
  });

  it('re-measures capacity during understated expansion before a later write', async () => {
    const file = await crafted([{ name: 'manifest.json', content: Buffer.alloc(3 * 1024 * 1024, 65) }]);
    let measurements = 0;
    jest.spyOn(fsp, 'statfs').mockImplementation(async () => (++measurements >= 7 ? { ...available, bavail: 1n } : available));
    const zip = await open(file);
    try {
      await expect(extractWithinLimits(zip, Object.values(await zip.entries()), workspace)).rejects.toMatchObject({ statusCode: 507 });
      expect(measurements).toBeGreaterThanOrEqual(7);
      await expect(fsp.stat(path.join(workspace, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await zip.close(); }
  });

  it('refuses pre-existing leaves and symlink directories without modifying unrelated bytes', async () => {
    const file = await archive([['manifest.json', '{}'], ['files/business-docs/a.txt', 'new']]);
    const zip = await open(file);
    try {
      await fsp.writeFile(path.join(workspace, 'manifest.json'), 'sentinel');
      await expect(extractWithinLimits(zip, Object.values(await zip.entries()), workspace)).rejects.toMatchObject({ statusCode: 400 });
      expect(await fsp.readFile(path.join(workspace, 'manifest.json'), 'utf8')).toBe('sentinel');
      await fsp.unlink(path.join(workspace, 'manifest.json'));
      await fsp.symlink(fixture, path.join(workspace, 'files'));
      await expect(extractWithinLimits(zip, Object.values(await zip.entries()), workspace)).rejects.toMatchObject({ statusCode: 400 });
      expect(await fsp.readdir(workspace)).toEqual(['files']);
    } finally { await zip.close(); }
  });

  it('refuses a non-private workspace', async () => {
    await fsp.chmod(workspace, 0o755);
    await expect(assertArchiveWithinLimits([{ name: 'manifest.json', size: 2 }], workspace)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a symlink workspace and a different persistent volume', async () => {
    const alias = path.join(fixture, 'workspace-alias');
    await fsp.symlink(workspace, alias);
    await expect(assertArchiveWithinLimits([{ name: 'manifest.json', size: 2 }], alias)).rejects.toMatchObject({ statusCode: 400 });
    const stat = fsp.stat.bind(fsp);
    jest.spyOn(fsp, 'stat').mockImplementation(async target => {
      const actual = await stat(target);
      if (target === fixture) return { ...actual, dev: actual.dev + 1, isDirectory: () => true };
      return actual;
    });
    await expect(assertArchiveWithinLimits([{ name: 'manifest.json', size: 2 }], workspace, { persistentRoot: fixture }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('handles malformed compressed bytes and active close without leaked fd reads', async () => {
    const malformed = await crafted([{ name: 'manifest.json', compressed: Buffer.from([255, 255, 255]) }]);
    const bad = await open(malformed);
    try { await expect(readEntryWithin(bad, 'manifest.json', 100)).rejects.toMatchObject({ statusCode: 400 }); }
    finally { await bad.close(); await bad.close(); }
    const file = await crafted([{ name: 'manifest.json', content: Buffer.alloc(8 * 1024 * 1024, 65) }]);
    const zip = await open(file);
    const stream = await zip.stream('manifest.json');
    const close = jest.spyOn(fs, 'close');
    await zip.close();
    await zip.close();
    expect(stream.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => fs.fstatSync(close.mock.calls[0][0])).toThrow(expect.objectContaining({ code: 'EBADF' }));
    await expect(zip.stream('manifest.json')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('waits for an entry-header operation before closing its descriptor', async () => {
    const zip = await open(await archive([['manifest.json', '{}']]));
    const pending = zip.stream('manifest.json');
    const outcome = pending.then(() => 'opened', error => error.statusCode);
    await zip.close();
    expect(await outcome).toBe(400);
    await zip.close();
  });
});
