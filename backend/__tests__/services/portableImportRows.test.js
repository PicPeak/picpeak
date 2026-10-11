'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { readNdjson, rowBatches, MAX_ROW_BYTES, MAX_BATCH_BINDINGS } = require('../../src/services/portableImportRows');

describe('bounded portable NDJSON processing', () => {
  let fixture;
  let file;
  const collect = async generator => { const results = []; for await (const result of generator) results.push(result); return results; };
  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-ndjson-'));
    file = path.join(fixture, 'rows.ndjson');
  });
  afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

  test('supports CRLF, blank rows, multilingual values and a last row without a newline', async () => {
    await fs.writeFile(file, '\r\n{"id":1,"text":"Grüße 🌅"}\r\n  \n{"id":2,"json":{"ok":true}}');
    expect((await collect(readNdjson(file))).map(value => value.row)).toEqual([
      { id: 1, text: 'Grüße 🌅' }, { id: 2, json: { ok: true } },
    ]);
  });
  test('refuses a large real line before parsing it, including a no-newline payload', async () => {
    await fs.writeFile(file, `{"text":"${'x'.repeat(MAX_ROW_BYTES)}"}`);
    await expect(collect(readNdjson(file))).rejects.toMatchObject({ code: 'PICPEAK_IMPORT_ROW_LIMIT' });
  });
  test('rejects invalid UTF8 instead of silently replacing bytes', async () => {
    await fs.writeFile(file, Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125, 10]));
    await expect(collect(readNdjson(file))).rejects.toThrow();
  });
  test.each(['null', '[]', '1', '"text"', '{}', '{"__proto__":{"polluted":true}}'])('refuses non-record/unsafe columns %s', async row => {
    await fs.writeFile(file, `${row}\n`);
    await expect(collect(readNdjson(file))).rejects.toMatchObject({ code: 'PICPEAK_IMPORT_ROW_LIMIT' });
    expect({}.polluted).toBeUndefined();
  });
  test('allows tighter but not disabled or enlarged limits', async () => {
    await fs.writeFile(file, '{"id":1}\n{"id":2}\n');
    await expect(collect(readNdjson(file, { rows: 1 }))).rejects.toMatchObject({ code: 'PICPEAK_IMPORT_ROW_LIMIT' });
    await expect(collect(readNdjson(file, { rowBytes: MAX_ROW_BYTES + 1 }))).rejects.toMatchObject({ code: 'PICPEAK_IMPORT_ROW_LIMIT' });
    await expect(collect(readNdjson(file, { rows: Infinity }))).rejects.toThrow();
    await expect(collect(readNdjson(file, { tableBytes: 5 }))).rejects.toThrow();
  });
  test('batch count, encoded bytes and union-of-columns bindings stay bounded', async () => {
    const rows = Array.from({ length: 230 }, (_, index) => Object.fromEntries(
      Array.from({ length: 20 }, (_, column) => [`field${index % 2 ? column : column + 10}`, `${index}:${column}`])
    ));
    await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
    const batches = await collect(rowBatches(file));
    expect(batches.flat()).toEqual(rows);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(100);
      expect(new Set(batch.flatMap(row => Object.keys(row))).size * batch.length).toBeLessThanOrEqual(MAX_BATCH_BINDINGS);
      expect(Buffer.byteLength(batch.map(row => JSON.stringify(row)).join('\n'))).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });
  test('backpressure retains only the current batch, not the unread table', async () => {
    await fs.writeFile(file, Array.from({ length: 1000 }, (_, id) => JSON.stringify({ id })).join('\n'));
    const batches = rowBatches(file);
    expect((await batches.next()).value).toHaveLength(100);
    await batches.return();
    // The descriptor is closed even when the consumer stops early.
    await fs.rename(file, `${file}.closed`);
  });
  test('symlinks and hardlinks are rejected; optional missing empty legacy files are explicit', async () => {
    await fs.writeFile(file, '{"id":1}\n');
    const linked = path.join(fixture, 'linked.ndjson');
    await fs.symlink(file, linked);
    await expect(collect(readNdjson(linked))).rejects.toThrow();
    await fs.unlink(linked);
    await fs.link(file, linked);
    await expect(collect(readNdjson(file))).rejects.toThrow();
    await expect(collect(readNdjson(path.join(fixture, 'missing')))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await collect(readNdjson(path.join(fixture, 'missing'), { allowMissing: true }))).toEqual([]);
  });
  test('100k ordinary rows stream through an actual64MiB-heap process', async () => {
    const handle = await fs.open(file, 'wx', 0o600);
    const row = `${JSON.stringify({ id: 1, text: 'ordinary'.repeat(64) })}\n`;
    try {
      const chunk = row.repeat(1000);
      for (let index = 0; index < 100; index++) await handle.writeFile(chunk);
    } finally { await handle.close(); }
    const modulePath = require.resolve('../../src/services/portableImportRows');
    const script = `const {rowBatches}=require(process.argv[1]);(async()=>{let count=0;for await(const batch of rowBatches(process.argv[2]))count+=batch.length;console.log(JSON.stringify({count,rss:process.memoryUsage().rss}));})().catch(e=>{console.error(e);process.exit(1)});`;
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=64', '-e', script, modulePath, file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.on('data', bytes => { output += bytes.toString(); });
      child.stderr.on('data', bytes => { errors += bytes.toString(); });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal, output, errors }));
    });
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    expect(exit.errors).toBe('');
    expect(JSON.parse(exit.output).count).toBe(100000);
    expect(JSON.parse(exit.output).rss).toBeLessThan(256 * 1024 * 1024);
  });
});
