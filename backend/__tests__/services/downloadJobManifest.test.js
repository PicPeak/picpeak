const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { once } = require('events');
const archiver = require('archiver');
const { buildEntryManifest } = require('../../src/services/downloadJobManifest');

it.each(['buffer', 'stream'])('reads ZIP64 boundaries for large %s entries under back-pressure', async (kind) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-manifest-test-'));
  const file = path.join(directory, 'archive.zip');
  const archive = archiver('zip', { forceZip64: true, zlib: { level: 0 } });
  const output = fs.createWriteStream(file, { highWaterMark: 1024 });
  const write = output._write.bind(output);
  output._write = (chunk, encoding, done) => setTimeout(() => write(chunk, encoding, done), 1);
  archive.pipe(output);
  try {
    const closed = once(output, 'close');
    const packaged = [];
    for (let i = 0; i < 3; i += 1) {
      const entry = once(archive, 'entry');
      const bytes = Buffer.alloc(8 * 1024 * 1024, i);
      const name = `photo-${i}.jpg`;
      archive.append(kind === 'buffer' ? bytes : Readable.from(bytes), { name });
      await entry;
      packaged.push({ photoId: i + 1, name });
    }
    await archive.finalize(); await closed;
    const manifest = await buildEntryManifest(file, packaged, (await fsp.stat(file)).size);
    const source = await fsp.open(file, 'r');
    try {
      expect(manifest).toHaveLength(3);
      for (const entry of manifest) {
        const header = Buffer.alloc(4);
        await source.read(header, 0, 4, entry.start);
        expect(header.readUInt32LE(0)).toBe(0x04034b50);
        expect(entry.end - entry.start).toBeGreaterThanOrEqual(8 * 1024 * 1024);
      }
      const central = Buffer.alloc(4);
      await source.read(central, 0, 4, manifest[2].end);
      expect(central.readUInt32LE(0)).toBe(0x02014b50);
    } finally { await source.close(); }
  } finally { archive.abort(); output.destroy(); await fsp.rm(directory, { recursive: true, force: true }); }
});
