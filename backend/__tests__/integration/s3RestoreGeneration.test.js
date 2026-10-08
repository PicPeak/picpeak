'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const knex = require('knex');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand,
  PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const S3StorageBackend = require('../../src/services/storage/S3StorageBackend');
const index = require('../../src/services/storage/generationIndex');
const migration = require('../../migrations/core/281_storage_s3_generation_index');
const nativeEndpoint = process.env.PICPEAK_GENERATION_S3_TEST_URL;
const read = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const metadata = { contentType: 'image/jpeg', contentDisposition: 'inline; filename="fixture.jpg"', cacheControl: 'private', metadata: { owner: 'fixture' } };
const key = 'events/active/ordinary/individual/with ü spaces.jpg';
let db; let storage; let objects; let client; let config; let temp;

beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-generation-test-'));
  db = knex({ client: 'sqlite3', connection: { filename: path.join(temp, 'index.sqlite') }, useNullAsDefault: true });
  await migration.up(db);
  await db.schema.createTable('restored_rows', table => { table.integer('id').primary(); table.text('value'); });
  config = { bucket: `picpeak-generation-${crypto.randomBytes(8).toString('hex')}`, region: 'us-east-1', prefix: 'owned-tenant', indexDatabase: db };
  if (nativeEndpoint) {
    Object.assign(config, { endpoint: nativeEndpoint, accessKeyId: 'owned-generation-access', secretAccessKey: 'owned-generation-secret', forcePathStyle: true, sslEnabled: false });
    client = new S3Client({ endpoint: nativeEndpoint, region: config.region, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, forcePathStyle: true });
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  }
});
beforeEach(async () => {
  await db(index.TABLE).del();
  await db('restored_rows').del();
  storage = new S3StorageBackend(config);
  if (!nativeEndpoint) {
    objects = new Map();
    storage.adapter = {
      bucket: config.bucket, testConnection: async () => true,
      uploadStream: async (stream, physical, options) => { objects.set(physical, { body: await read(stream), options }); },
      upload: async (file, physical, options) => { objects.set(physical, { body: await fs.readFile(file), options }); },
      downloadStream: async (physical, options = {}) => {
        const obj = objects.get(physical); if (!obj) throw Object.assign(new Error('Missing'), { name: 'NotFound' });
        if (options.range) { const [, start, end] = /bytes=(\d+)-(\d+)/.exec(options.range); return Readable.from(obj.body.subarray(Number(start), Number(end) + 1)); }
        return Readable.from(obj.body);
      },
      exists: async physical => objects.has(physical), delete: async physical => { objects.delete(physical); },
      download: async (physical, file) => fs.writeFile(file, objects.get(physical).body),
      list: async prefix => ({ Contents: [...objects].filter(([physical]) => physical.startsWith(prefix)).map(([physical, obj]) => ({ Key: physical, Size: obj.body.length })) }),
      copy: async (src, dst) => { const obj = objects.get(src); objects.set(dst, { body: Buffer.from(obj.body), options: obj.options }); },
      getSignedUrl: async (_operation, physical) => `https://owned.invalid/${physical}`,
      s3Client: { send: async command => {
        const obj = objects.get(command.input.Key); if (!obj) throw Object.assign(new Error('Missing'), { name: 'NotFound' });
        return { ContentLength: obj.body.length, ContentType: obj.options.contentType, ContentDisposition: obj.options.contentDisposition,
          CacheControl: obj.options.cacheControl, Metadata: obj.options.metadata, ETag: `"${digest(obj.body)}"` };
      } },
    };
  }
  await storage.init();
  await storage.put(key, Buffer.from('old-original'), metadata);
});
afterEach(async () => {
  if (client) {
    let token;
    do {
      const result = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: token }));
      if (result.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: result.Contents.map(obj => ({ Key: obj.Key })) } }));
      token = result.NextContinuationToken;
    } while (token);
  }
});
afterAll(async () => {
  if (client) { await client.send(new DeleteBucketCommand({ Bucket: config.bucket })); client.destroy(); }
  await db.destroy(); await fs.rm(temp, { recursive: true, force: true });
});

async function verify(generation, logical, body, options = metadata) {
  expect(await read(await generation.storage.get(logical))).toEqual(body);
  expect(await generation.storage.stat(logical)).toMatchObject({ size: body.length, ...options });
  generation.recordVerified(logical, { checksum: digest(body), size: body.length, object_metadata: options });
}
async function restart() { await storage.init(); }

it('publishes rows and logical representation in the SAME transaction; before restart old bytes remain', async () => {
  const generation = storage.createRestoreGeneration('attempt-ordinary', [key]);
  const body = Buffer.from('new-original');
  await generation.storage.put(key, body, metadata);
  await verify(generation, key, body);
  const manifest = generation.manifest();
  expect(manifest.files[0]).toMatchObject({ logical: key, size: body.length, checksum: digest(body), object_metadata: metadata });
  expect(manifest.files[0].physical).toMatch(/^\.picpeak-generations\/attempt-ordinary\//);
  expect(await read(await storage.get(key))).toEqual(Buffer.from('old-original'));
  await db.transaction(async trx => {
    await trx('restored_rows').insert({ id: 1, value: 'new row' });
    expect(await generation.publish(trx)).toEqual({ revision: manifest.revision, stagedKeys: 1 });
  });
  expect(await read(await storage.get(key))).toEqual(Buffer.from('old-original'));
  await restart();
  expect(await read(await storage.get(key))).toEqual(body);
  expect((await db('restored_rows').first()).value).toBe('new row');
  expect((await storage.list('events/active/')).map(entry => entry.key)).toEqual([key]);
  expect((await storage.list('')).map(entry => entry.key)).toEqual([key]);
});

it('a transaction rollback leaves original rows/bytes and staged objects unexposed across restart', async () => {
  const generation = storage.createRestoreGeneration('attempt-rollback', [key]);
  await generation.storage.put(key, Buffer.from('rolled-back'), metadata);
  await verify(generation, key, Buffer.from('rolled-back'));
  await expect(db.transaction(async trx => {
    await trx('restored_rows').insert({ id: 1, value: 'must roll back' });
    await generation.publish(trx); throw new Error('injected commit failure');
  })).rejects.toThrow('injected commit failure');
  await restart();
  expect(await db('restored_rows')).toEqual([]);
  expect(await read(await storage.get(key))).toEqual(Buffer.from('old-original'));
  expect((await storage.list('')).map(entry => entry.key)).toEqual([key]);
});

it('a failed remote put may complete AFTER retry/publication without replacing old or selected bytes', async () => {
  const generation = storage.createRestoreGeneration('attempt-late-put', [key]);
  const upload = storage.adapter.uploadStream.bind(storage.adapter);
  let finishLate;
  storage.adapter.uploadStream = async (stream, physical, options) => {
    const data = await read(stream);
    finishLate = () => upload(Readable.from(data), physical, options);
    throw new Error('client died after remote acceptance');
  };
  await expect(generation.storage.put(key, Buffer.from('late-failed-bytes'), metadata)).rejects.toThrow('client died');
  storage.adapter.uploadStream = upload;
  await generation.storage.put(key, Buffer.from('retry-winner'), metadata);
  await verify(generation, key, Buffer.from('retry-winner'));
  const manifest = generation.manifest();
  expect(manifest.writes.map(write => write.status)).toEqual(['uncertain', 'completed']);
  expect(new Set(manifest.writes.map(write => write.physical)).size).toBe(2);
  await db.transaction(trx => generation.publish(trx));
  await restart();
  await finishLate(); // Real MinIO write when native fixture is enabled.
  expect(await read(await storage.get(key))).toEqual(Buffer.from('retry-winner'));
  expect((await storage.list('')).map(entry => entry.key)).toEqual([key]);
  const legacy = nativeEndpoint ? await read((await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${key}` }))).Body)
    : objects.get(`${config.prefix}/${key}`).body;
  expect(legacy).toEqual(Buffer.from('old-original'));
});

it('carries unaffected mapped originals when a documents-only restore overlays a new key', async () => {
  const first = storage.createRestoreGeneration('attempt-originals', [key]);
  await first.storage.put(key, Buffer.from('retained-photo'), metadata); await verify(first, key, Buffer.from('retained-photo'));
  await db.transaction(trx => first.publish(trx)); await restart();
  const doc = 'business-docs/customer-documents/owned.pdf';
  const second = storage.createRestoreGeneration('attempt-documents', [doc]);
  const options = { contentType: 'application/pdf', contentDisposition: 'attachment', metadata: { owner: 'fixture' } };
  const file = path.join(temp, 'owned.pdf'); await fs.writeFile(file, 'document');
  await second.storage.putFromFile(doc, file, options); await verify(second, doc, Buffer.from('document'), options);
  await db.transaction(trx => second.publish(trx)); await restart();
  expect(await read(await storage.get(key))).toEqual(Buffer.from('retained-photo'));
  expect((await storage.list('')).map(entry => entry.key).sort()).toEqual([doc, key].sort());
});

it('enforces mapped get/range/file/stat/put/copy/rename/delete/signed URLs without reviving shadowed legacy bytes', async () => {
  const generation = storage.createRestoreGeneration('attempt-all-paths', [key]);
  await generation.storage.put(key, Buffer.from('abcdefghij'), metadata); await verify(generation, key, Buffer.from('abcdefghij'));
  await db.transaction(trx => generation.publish(trx)); await restart();
  expect(await read(await storage.getRange(key, 2, 5))).toEqual(Buffer.from('cdef'));
  const output = path.join(temp, 'download'); await storage.getToFile(key, output); expect(await fs.readFile(output)).toEqual(Buffer.from('abcdefghij'));
  const url = await storage.signedUrl(key); expect(decodeURIComponent(url)).toContain(generation.manifest().files[0].physical);
  await storage.put(key, Readable.from('updated-mapped'), metadata);
  await storage.copy(key, 'events/active/ordinary/copied.jpg');
  await storage.rename('events/active/ordinary/copied.jpg', 'events/active/ordinary/renamed.jpg');
  expect(await read(await storage.get('events/active/ordinary/renamed.jpg'))).toEqual(Buffer.from('updated-mapped'));
  await storage.copy('events/active/ordinary/renamed.jpg', key); expect(await storage.stat(key)).toMatchObject(metadata);
  await storage.delete(key);
  expect(await storage.exists(key)).toBe(false); expect(await storage.stat(key)).toBeNull();
  expect((await storage.list('')).some(entry => entry.key === key)).toBe(false);
  await restart(); expect(await storage.exists(key)).toBe(false);
  await storage.putFromFile(key, output, metadata); expect(await read(await storage.get(key))).toEqual(Buffer.from('abcdefghij'));
});

it('rejects incomplete/unverified/nontransaction/out-of-plan/concurrent/stale publication', async () => {
  const generation = storage.createRestoreGeneration('attempt-refusals', [key, 'thumbnails/missing.jpg']);
  await expect(generation.storage.get(key)).rejects.toThrow('not staged');
  await expect(generation.storage.put('thumbnails/other.jpg', Buffer.from('x'))).rejects.toThrow('outside');
  await expect(generation.publish(db)).rejects.toThrow('transaction');
  await generation.storage.put(key, Buffer.from('x'), metadata); await verify(generation, key, Buffer.from('x'));
  await expect(db.transaction(trx => generation.publish(trx))).rejects.toThrow('incomplete');
  const complete = storage.createRestoreGeneration('attempt-unverified', [key]);
  await complete.storage.put(key, Buffer.from('x'), metadata);
  await expect(db.transaction(trx => complete.publish(trx))).rejects.toThrow('unverified');
  await verify(complete, key, Buffer.from('x'));
  const foreignRevision = index.encodeRows(storage.namespace, new Map());
  await db(index.TABLE).insert(foreignRevision);
  await expect(db.transaction(trx => complete.publish(trx))).rejects.toThrow('changed');
});

it('rejects concurrent writes and publication while a remote stage is still in flight', async () => {
  const generation = storage.createRestoreGeneration('attempt-inflight', [key]);
  const upload = storage.adapter.uploadStream.bind(storage.adapter);
  let resume;
  storage.adapter.uploadStream = (stream, physical, options) => new Promise(resolve => { resume = async () => { await upload(stream, physical, options); resolve(); }; });
  const pending = generation.storage.put(key, Buffer.from('owned-inflight'), metadata);
  expect(generation.manifest().writes[0].status).toBe('in-flight');
  await expect(generation.storage.put(key, Buffer.from('conflicting'), metadata)).rejects.toThrow('Concurrent');
  await expect(db.transaction(trx => generation.publish(trx))).rejects.toThrow('incomplete');
  await resume(); await pending; storage.adapter.uploadStream = upload;
  await verify(generation, key, Buffer.from('owned-inflight'));
  await db.transaction(trx => generation.publish(trx)); await restart();
  expect(await read(await storage.get(key))).toEqual(Buffer.from('owned-inflight'));
});

it('same-install engine migration sidecar is private/namespace-bound, never an archive reset', async () => {
  const generation = storage.createRestoreGeneration('attempt-sidecar', [key]);
  await generation.storage.put(key, Buffer.from('sidecar-original'), metadata); await verify(generation, key, Buffer.from('sidecar-original'));
  await db.transaction(trx => generation.publish(trx)); await restart();
  const file = path.join(temp, `migration-${crypto.randomUUID()}.json`);
  await index.writeMigrationIndex(file, db);
  expect((await fs.stat(file)).mode & 0o077).toBe(0);
  const rows = await index.readMigrationIndex(file, storage.namespace);
  expect(rows).toEqual(await db(index.TABLE));
  await expect(index.readMigrationIndex(file, '0'.repeat(64))).rejects.toThrow('foreign');
  await fs.chmod(file, 0o644); await expect(index.readMigrationIndex(file, storage.namespace)).rejects.toThrow('non-private');
  await fs.chmod(file, 0o600); const link = `${file}.link`; await fs.symlink(file, link);
  await expect(index.readMigrationIndex(link, storage.namespace)).rejects.toThrow();
});

it.each(['../x', 'events/../x', '/absolute', './events/x', 'events//x', 'events/./x', 'events\\x', '.picpeak-generations/attempt-whatever/object'])('rejects bypass key %s across read/write/list/signed and stage plans', async bad => {
  await expect(storage.put(bad, Buffer.from('x'))).rejects.toThrow();
  await expect(storage.get(bad)).rejects.toThrow();
  await expect(storage.list(bad)).rejects.toThrow();
  await expect(storage.signedUrl(bad)).rejects.toThrow();
  expect(() => storage.createRestoreGeneration('attempt-validation', [bad])).toThrow();
});

it('fails closed for missing/corrupt/foreign/aliased/oversized index; no lazy IO DB query', async () => {
  const rows = index.encodeRows(storage.namespace, new Map());
  await db(index.TABLE).insert({ ...rows[0], mapping: 'not json' });
  await expect(storage.init()).rejects.toThrow('Corrupt'); await expect(storage.get(key)).rejects.toThrow('initialized');
  await db(index.TABLE).update({ mapping: rows[0].mapping, namespace: '0'.repeat(64) });
  await expect(storage.init()).rejects.toThrow('foreign');
  await db(index.TABLE).del(); await storage.init();
  const physical = `.picpeak-generations/attempt-alias/${crypto.randomUUID()}`;
  expect(() => index.validateRows([{ ...rows[0], mapping: JSON.stringify({ version: 1, entries: [[key, physical], ['thumbnails/x', physical]] }) }], storage.namespace)).toThrow('physical');
  expect(() => storage.createRestoreGeneration('attempt-overcount', Array(index.MAX_ENTRIES + 1).fill(key))).toThrow('plan');
  expect(() => index.validateRows([{ ...rows[0], mapping: 'x'.repeat(index.MAX_ENCODED_BYTES + 1) }])).toThrow('oversized');
  await db.schema.dropTable(index.TABLE); await expect(storage.init()).rejects.toThrow('unavailable'); await migration.up(db); await storage.init();
  await db.transaction(async trx => { await trx('restored_rows').insert({ id: 1, value: 'held connection' }); expect(await read(await storage.get(key))).toEqual(Buffer.from('old-original')); });
});

it('preserves target map when full native DB restore imports foreign or old index data/schema; exported index is excluded', async () => {
  const generation = storage.createRestoreGeneration('attempt-target-map', [key]);
  await generation.storage.put(key, Buffer.from('target-selected'), metadata); await verify(generation, key, Buffer.from('target-selected'));
  await db.transaction(trx => generation.publish(trx)); await restart();
  const snapshot = await index.snapshotDatabaseIndex(db);
  await db(index.TABLE).update({ namespace: '0'.repeat(64), revision: crypto.randomUUID(), mapping: JSON.stringify({ version: 1, entries: [] }) });
  await index.restoreDatabaseIndex(db, snapshot); await restart();
  expect(await read(await storage.get(key))).toEqual(Buffer.from('target-selected'));
  await db.schema.dropTable(index.TABLE); await index.restoreDatabaseIndex(db, snapshot); await restart();
  expect(await read(await storage.get(key))).toEqual(Buffer.from('target-selected'));
  await migration.up(db); await migration.up(db); await expect(migration.down(db)).rejects.toThrow('active');
  const { EXCLUDED_TABLES } = require('../../src/services/picpeakExportService');
  expect(EXCLUDED_TABLES.has(index.TABLE)).toBe(true);
});

it('actual portable export captures published logical bytes/metadata, never internal or uncertain stage objects', async () => {
  const generation = storage.createRestoreGeneration('attempt-real-export', [key]);
  await generation.storage.put(key, Buffer.from('exported-published'), metadata); await verify(generation, key, Buffer.from('exported-published'));
  await db.transaction(trx => generation.publish(trx)); await restart();
  const abandoned = storage.createRestoreGeneration('attempt-abandoned', [key]);
  await abandoned.storage.put(key, Buffer.from('unexposed-stage'), metadata);
  const { setStorageForTesting, resetStorage } = require('../../src/services/storage');
  const { db: exportDb } = require('../../src/database/db');
  await migration.up(exportDb);
  await exportDb(index.TABLE).del(); await exportDb(index.TABLE).insert(await db(index.TABLE));
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const StreamZip = require('node-stream-zip');
  setStorageForTesting(storage);
  let archive;
  try {
    archive = await createPicpeak({ includePhotos: true });
    expect(Object.keys(archive.manifest.tables)).not.toContain(index.TABLE);
    expect(archive.manifest.files).toEqual([expect.objectContaining({ path: key, checksum: digest('exported-published'), object_metadata: metadata })]);
    const zip = new StreamZip.async({ file: archive.filePath });
    try {
      expect(await zip.entryData(`files/${key}`)).toEqual(Buffer.from('exported-published'));
      expect(Object.keys(await zip.entries()).some(name => name.includes('.picpeak-generations') || name.includes(index.TABLE))).toBe(false);
    } finally { await zip.close(); }
  } finally {
    resetStorage(); if (archive) await fs.rm(path.dirname(archive.filePath), { recursive: true, force: true });
    await exportDb(index.TABLE).del();
  }
});

const nativeTest = nativeEndpoint ? it : it.skip;
nativeTest('native multipart staging keeps metadata and logical keys (6MiB stream)', async () => {
  const generation = storage.createRestoreGeneration('attempt-multipart', [key]);
  const body = Buffer.alloc(6 * 1024 * 1024, 97);
  await generation.storage.put(key, Readable.from(body), metadata); await verify(generation, key, body);
  await db.transaction(trx => generation.publish(trx)); await restart();
  expect(await storage.stat(key)).toMatchObject({ size: body.length, ...metadata });
  expect(await read(await storage.getRange(key, 5 * 1024 * 1024, 5 * 1024 * 1024 + 10))).toEqual(Buffer.alloc(11, 97));
});

nativeTest('native accepted PUT finishes after SIGKILL without exposing failed-stage bytes', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const upstream = new URL(nativeEndpoint);
  let release; let acceptedResolve;
  const accepted = new Promise(resolve => { acceptedResolve = resolve; });
  let latePhysical;
  const proxy = http.createServer(async (request, response) => {
    if (request.method !== 'PUT') {
      const forward = http.request({ hostname: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: request.headers }, result => {
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      forward.on('error', error => response.destroy(error)); request.pipe(forward); return;
    }
    const body = await read(request);
    latePhysical = decodeURIComponent(request.url.split('?')[0].split('/').slice(2).join('/'));
    release = () => new Promise((resolve, reject) => {
      const forward = http.request({ hostname: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: request.headers }, result => {
        result.resume(); result.on('end', () => result.statusCode < 300 ? resolve() : reject(new Error(`Late PUT returned ${result.statusCode}`)));
      });
      forward.on('error', reject); forward.end(body);
    });
    acceptedResolve(); // Client has sent its body; remote completion remains uncertain.
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); // Owned Linux container only.
  const childConfig = { ...config, endpoint: `http://127.0.0.1:${proxy.address().port}`, indexDatabase: undefined };
  const code = `const knex=require('knex'); const Backend=require(${JSON.stringify(require.resolve('../../src/services/storage/S3StorageBackend'))});
    (async()=>{ const db=knex({client:'sqlite3',connection:{filename:${JSON.stringify(path.join(temp, 'index.sqlite'))}},useNullAsDefault:true});
    const storage=new Backend({...${JSON.stringify(childConfig)},indexDatabase:db}); await storage.init();
    const generation=storage.createRestoreGeneration('attempt-killed-client',[${JSON.stringify(key)}]);
    await generation.storage.put(${JSON.stringify(key)},Buffer.from('remote-after-client-death'),${JSON.stringify(metadata)}); await db.destroy(); })().catch(e=>{process.stderr.write(e.stack);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = ''; child.stderr.on('data', data => { childError += data.toString(); });
  try {
    await Promise.race([accepted, new Promise((_, reject) => child.once('exit', code => reject(new Error(`Fixture exited early ${code}: ${childError}`))))]);
    const dead = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL'); expect(await dead).toBe('SIGKILL');
    await release();
    const late = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: latePhysical }));
    expect(await read(late.Body)).toEqual(Buffer.from('remote-after-client-death'));
    expect(late).toMatchObject({ ContentType: metadata.contentType, ContentDisposition: metadata.contentDisposition, Metadata: metadata.metadata });
    await restart();
    expect(await read(await storage.get(key))).toEqual(Buffer.from('old-original'));
    expect((await storage.list('')).map(entry => entry.key)).toEqual([key]);
    expect(await db(index.TABLE)).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  }
}, 30000);
