'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

const endpoint = process.env.PICPEAK_GENERATION_S3_TEST_URL;
const native = process.platform === 'linux' && endpoint ? describe : describe.skip;
const key = 'events/active/owned-gallery/individual/ordinary ü.jpg';
const metadata = { contentType: 'image/jpeg', contentDisposition: 'inline; filename="ordinary.jpg"',
  cacheControl: 'private, max-age=17', metadata: { fixture: 'preserved' } };
const read = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function pdf(label) {
  const Document = require('pdfkit');
  const document = new Document({ size: 'A5' });
  const bytes = read(document);
  document.text(label); document.end();
  return bytes;
}
async function zippedPhoto(bytes) {
  const archive = require('archiver')('zip', { zlib: { level: 1 } });
  archive.append(bytes, { name: 'owned-old/individual/original.jpg' });
  const [result] = await Promise.all([read(archive), archive.finalize()]);
  return result;
}

native('actual portable worker with primary MinIO generations', () => {
  let db; let cleanup; let adminId; let client; let bucketCreated = false;
  let storage; let exported; let original; let first; let second; let customerId;
  const remote = new Map();
  const local = new Map();
  const bucket = `picpeak-owned-worker-${crypto.randomUUID()}`;
  const saved = new Map();
  const set = (name, value) => { saved.set(name, process.env[name]); process.env[name] = value; };
  const marker = async value => db('app_settings').insert({ setting_key: 'owned_s3_atomic_marker',
    setting_value: JSON.stringify(value), setting_type: 'string' }).onConflict('setting_key').merge();
  const readMarker = async () => decodeSettingValue(db,
    (await db('app_settings').where({ setting_key: 'owned_s3_atomic_marker' }).first()).setting_value);
  const restartStorage = async () => {
    require('../../src/services/storage').resetStorage();
    storage = await require('../../src/services/storage').initStorage();
  };
  const restore = () => require('../../src/services/picpeakImportService').importFromPicpeak({
    picpeakPath: exported.filePath, currentAdminId: adminId });
  const localFile = key => path.join(process.env.STORAGE_PATH, ...key.split('/'));
  async function writeRemoteEstate(phase) {
    for (const [name, value] of remote) await storage.put(name, value[phase], value.metadata);
  }
  async function writeLocalEstate(phase) {
    for (const [name, value] of local) {
      await fs.mkdir(path.dirname(localFile(name)), { recursive: true });
      await fs.writeFile(localFile(name), value[phase]);
    }
  }
  async function assertRemoteEstate(phase, { opaque = true } = {}) {
    expect((await storage.list('')).map(file => file.key).sort()).toEqual([...remote.keys()].sort());
    for (const [name, value] of remote) {
      expect(await read(await storage.get(name))).toEqual(value[phase]);
      expect(await storage.stat(name)).toMatchObject({ size: value[phase].length, ...value.metadata });
      const physical = storage.mapping.get(name);
      if (opaque) expect(physical).toMatch(/^\.picpeak-generations\//);
      const object = await client.send(new GetObjectCommand({ Bucket: bucket,
        Key: `${storage.prefix}/${physical || name}` }));
      expect(await read(object.Body)).toEqual(value[phase]);
      expect(object).toMatchObject({ ContentLength: value[phase].length,
        ContentType: value.metadata.contentType, ContentDisposition: value.metadata.contentDisposition,
        CacheControl: value.metadata.cacheControl, Metadata: value.metadata.metadata });
      await expect(fs.access(localFile(name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }
  async function assertLocalEstate(phase) {
    for (const [name, value] of local) {
      expect(await fs.readFile(localFile(name))).toEqual(value[phase]);
      expect(await storage.stat(name)).toBeNull();
      expect(storage.mapping.has(name)).toBe(false);
    }
  }
  async function withImportPreload(name, source, run) {
    // Inject only into the actual import Node launcher. The original native
    // runner/worker, hard budgets, lifetime FD and recovery path all execute.
    const preload = path.join(path.dirname(process.env.STORAGE_PATH), `${name}.cjs`);
    await fs.writeFile(preload, source, { mode: 0o600 });
    const runner = require('../../src/services/nativeProcessRunner');
    const originalRun = runner.run;
    const spy = jest.spyOn(runner, 'run').mockImplementation((command, args, options) =>
      originalRun(command, args.includes('import') ? ['--require', preload, ...args] : args, options));
    try { return await run(); } finally { spy.mockRestore(); await fs.unlink(preload); }
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    for (const [name, value] of Object.entries({ STORAGE_BACKEND: 's3', STORAGE_S3_ENDPOINT: endpoint,
      STORAGE_S3_BUCKET: bucket, STORAGE_S3_REGION: 'us-east-1', STORAGE_S3_PREFIX: 'owned-worker',
      STORAGE_S3_ACCESS_KEY: 'owned-generation-access', STORAGE_S3_SECRET_KEY: 'owned-generation-secret',
      STORAGE_S3_FORCE_PATH_STYLE: 'true', STORAGE_S3_SSL: 'false' })) set(name, value);
    client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: process.env.STORAGE_S3_ACCESS_KEY, secretAccessKey: process.env.STORAGE_S3_SECRET_KEY } });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    await restartStorage();
    const [event] = await db('events').insert({ slug: 'owned-gallery', event_name: 'Owned worker gallery', event_type: 'wedding',
      event_date: '2026-10-08', host_email: 'fixture@example.com', admin_email: 'fixture@example.com',
      password_hash: 'owned-fixture', share_link: 'owned-worker-gallery', expires_at: '2027-10-08' }).returning('id');
    await db('photos').insert({ event_id: event.id || event, filename: 'ordinary ü.jpg',
      path: 'owned-gallery/individual/ordinary ü.jpg', type: 'individual', thumbnail_path: 'thumbnails/ordinary.jpg' });
    const image = async color => require('sharp')({ create: {
      width: 16, height: 16, channels: 3, background: color } }).jpeg().toBuffer();
    const images = { backup: await image('#496d89'), current: await image('#dc632e'), prior: await image('#30854e') };
    original = images.backup;
    remote.set(key, { ...images, metadata });
    for (const root of ['thumbnails', 'previews', 'heroes', 'watermarks']) {
      remote.set(`${root}/ordinary.jpg`, { ...images, metadata: { ...metadata,
        contentDisposition: `inline; filename="${root}.jpg"`, metadata: { fixture: root } } });
    }
    const video = await fs.readFile(path.resolve(__dirname, '../../../test-assets/test-video.mp4'));
    remote.set('videos/ordinary.mp4', { backup: video, current: video, prior: video,
      metadata: { contentType: 'video/mp4', contentDisposition: 'inline; filename="ordinary.mp4"',
        cacheControl: 'private, max-age=17', metadata: { fixture: 'video' } } });
    const archiveKey = 'events/archived/owned-old.zip';
    await db('events').insert({ slug: 'owned-old', event_name: 'Owned archived gallery', event_type: 'wedding',
      event_date: '2026-10-08', host_email: 'fixture@example.com', admin_email: 'fixture@example.com',
      password_hash: 'owned-fixture', share_link: 'owned-old-gallery', expires_at: '2027-10-08',
      is_archived: 1, archive_path: archiveKey });
    remote.set(archiveKey, { backup: await zippedPhoto(images.backup), current: await zippedPhoto(images.current),
      prior: await zippedPhoto(images.prior), metadata: { contentType: 'application/zip',
        contentDisposition: 'attachment; filename="owned-old.zip"', cacheControl: 'private, max-age=17', metadata: { fixture: 'archive' } } });
    const customerKey = `business-docs/customer-documents/${customerId}/customer.pdf`;
    const customer = { backup: await pdf('Backup customer document'), current: await pdf('Current customer document'),
      prior: await pdf('Prior customer document'), metadata: { contentType: 'application/pdf',
        contentDisposition: 'attachment; filename="customer.pdf"', cacheControl: 'private, max-age=17', metadata: { fixture: 'customer' } } };
    remote.set(customerKey, customer);
    // Stable supports this primary-object root but predates the portal table.
    if (await db.schema.hasTable('customer_documents')) await db('customer_documents').insert({
      customer_account_id: customerId, uploader_type: 'admin', original_name: 'customer.pdf', storage_key: customerKey,
      size_bytes: customer.backup.length, sha256: sha(customer.backup), status: 'clean' });
    await db('transfers').insert({ id: 1, token: 'ab'.repeat(32), title: 'Owned transfer', expires_at: '2027-10-08' });
    for (const [table, name, extension] of [['transfer_extra_files', 'transfers/1/files/extra.html', 'html'],
      ['transfer_uploads', 'uploads/transfers/1/upload.js', 'js']]) {
      await db(table).insert({ transfer_id: 1, original_filename: `owned.${extension}`, stored_path: name });
      const attachment = phase => Buffer.from(extension === 'html'
        ? `<!doctype html><html><body>Owned ${phase} attachment</body></html>` : `const ownedPhase = ${JSON.stringify(phase)};\n`);
      remote.set(name, { backup: attachment('backup'), current: attachment('current'), prior: attachment('prior'),
        metadata: { contentType: 'application/octet-stream', contentDisposition: 'attachment',
          cacheControl: 'private, max-age=17', metadata: { fixture: table } } });
    }
    local.set('business-docs/a.dat', { backup: Buffer.from('BACKUP-A'), current: Buffer.from('CURRENT-A'), prior: Buffer.from('PRIOR-A') });
    local.set('business-docs/z.dat', { backup: Buffer.from('BACKUP-Z'), current: Buffer.from('CURRENT-Z'), prior: Buffer.from('PRIOR-Z') });
    local.set('business-docs/invoice/2026/invoice.pdf', { backup: await pdf('Backup CRM invoice'),
      current: await pdf('Current CRM invoice'), prior: await pdf('Prior CRM invoice') });
    const logo = color => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${color}"/></svg>`);
    local.set('uploads/logos/logo.svg', { backup: logo('#496d89'), current: logo('#dc632e'), prior: logo('#30854e') });
    first = localFile('business-docs/a.dat'); second = localFile('business-docs/z.dat');
    expect(remote.size).toBe(10); expect(local.size).toBe(4);
    await writeRemoteEstate('backup'); await writeLocalEstate('backup');
    await marker('backup');
    exported = await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: true });
    expect(exported.manifest.files.find(file => file.path === key).object_metadata).toEqual(metadata);
    expect(exported.manifest.file_count).toBe(remote.size + local.size);
    expect(exported.manifest.files.map(file => file.path).sort()).toEqual([...remote.keys(), ...local.keys()].sort());
    for (const [name, value] of remote) expect(exported.manifest.files.find(file => file.path === name)).toMatchObject({
      size: value.backup.length, checksum: sha(value.backup), object_metadata: value.metadata });
    for (const [name, value] of local) {
      const entry = exported.manifest.files.find(file => file.path === name);
      expect(entry).toMatchObject({ size: value.backup.length, checksum: sha(value.backup) });
      expect(entry.object_metadata).toBeUndefined();
    }
    expect(exported.manifest.tables.storage_s3_generation_index).toBeUndefined();
    expect(exported.manifest.tables.portable_restore_control).toBeUndefined();
    await marker('current');
    await writeRemoteEstate('current'); await writeLocalEstate('current');
    await fs.unlink(second); await fs.mkdir(second); await fs.writeFile(path.join(second, 'sentinel'), 'CURRENT-KEEP');
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/nativeProcessRunner').stop();
    require('../../src/services/storage').resetStorage();
    if (bucketCreated) {
      let token;
      do {
        const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        if (result.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket,
          Delete: { Objects: result.Contents.map(object => ({ Key: object.Key })) } }));
        token = result.NextContinuationToken;
      } while (token);
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    client?.destroy();
    for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    if (exported) await fs.rm(path.dirname(exported.filePath), { recursive: true, force: true });
    if (cleanup) await cleanup();
  });

  test('a local collision leaves prior rows, local files, remote bytes and mapping untouched', async () => {
    await expect(restore()).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    expect(await readMarker()).toBe('current');
    expect(await fs.readFile(first, 'utf8')).toBe('CURRENT-A');
    expect(await fs.readFile(path.join(second, 'sentinel'), 'utf8')).toBe('CURRENT-KEEP');
    await restartStorage();
    expect(await read(await storage.get(key))).toEqual(remote.get(key).current);
    await assertRemoteEstate('current', { opaque: false });
    for (const name of [...local.keys()].filter(name => name !== 'business-docs/z.dat')) {
      expect(await fs.readFile(localFile(name))).toEqual(local.get(name).current);
      expect(await storage.stat(name)).toBeNull();
    }
    expect(await db('storage_s3_generation_index')).toEqual([]);
  }, 120000);

  test('a genuine hybrid archive publishes the opaque generation with rows and the local journal', async () => {
    await fs.unlink(path.join(second, 'sentinel')); await fs.rmdir(second); await fs.writeFile(second, 'CURRENT-Z');
    expect(await restore()).toMatchObject({ restored: true, outcome: 'committed',
      filesRestored: remote.size + local.size, restartRequired: true });
    // Activation deliberately requires a cold storage instance, just like the
    // coordinated application restart; no live cache is silently switched.
    await restartStorage();
    expect(await readMarker()).toBe('backup');
    expect(await fs.readFile(first, 'utf8')).toBe('BACKUP-A');
    expect(await fs.readFile(second, 'utf8')).toBe('BACKUP-Z');
    expect(await read(await storage.get(key))).toEqual(original);
    expect(await storage.stat(key)).toMatchObject({ size: original.length, ...metadata });
    await assertRemoteEstate('backup'); await assertLocalEstate('backup');
    const control = await db('portable_restore_control').where({ id: 1 }).first();
    const commit = await db('portable_restore_commits').where({ attempt_id: control.attempt_id }).first();
    const index = await db('storage_s3_generation_index').where({ id: 1 }).first();
    expect(commit.s3_revision).toBe(index.revision);
    expect(commit.s3_namespace).toBe(index.namespace);
    expect(commit.s3_manifest_checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.mapping.size).toBe(remote.size);
    expect(storage.mapping.get(key)).toMatch(/^\.picpeak-generations\//);
  }, 120000);

  test('SIGKILL after promotion rolls back the same index transaction while staged objects stay invisible', async () => {
    await marker('before-crash'); await writeLocalEstate('prior'); await writeRemoteEstate('prior');
    const priorIndex = await db('storage_s3_generation_index').where({ id: 1 }).first();
    const preload = `const {PortableRestoreJournal:J}=require(${JSON.stringify(require.resolve('../../src/services/portableRestoreJournal'))});
      const promote=J.prototype.promote;J.prototype.promote=function(source){return promote.call(this,source,{onStep:()=>process.kill(process.pid,'SIGKILL')})};`;
    await withImportPreload('owned-s3-promotion-crash', preload, async () => {
      await expect(restore()).rejects.toMatchObject({ code: 'RESTORE_ROLLED_BACK' });
    });
    await restartStorage();
    expect(await readMarker()).toBe('before-crash');
    expect(await fs.readFile(first, 'utf8')).toBe('PRIOR-A');
    expect(await fs.readFile(second, 'utf8')).toBe('PRIOR-Z');
    expect(await read(await storage.get(key))).toEqual(remote.get(key).prior);
    await assertRemoteEstate('prior'); await assertLocalEstate('prior');
    expect(await db('storage_s3_generation_index').where({ id: 1 }).first()).toEqual(priorIndex);
    const control = await db('portable_restore_control').where({ id: 1 }).first();
    expect(control.state).toBe('restart_required');
    expect(JSON.parse(control.result_json)).toMatchObject({ outcome: 'rolled_back', recoveryAttempted: true });
    expect(await db('portable_restore_commits').where({ attempt_id: control.attempt_id })).toEqual([]);
  }, 120000);

  test('actual SIGKILL after acknowledged COMMIT retains new rows/local files and the cold opaque S3 generation', async () => {
    await marker('before-ack-crash'); await writeLocalEstate('prior'); await writeRemoteEstate('prior');
    const priorIndex = await db('storage_s3_generation_index').where({ id: 1 }).first();
    const priorMapping = new Map(storage.mapping);
    const evidence = path.join(path.dirname(process.env.STORAGE_PATH), 'owned-s3-commit-ack.json');
    const preload = `const fs=require('fs');const T=require(${JSON.stringify(require.resolve('knex/lib/execution/transaction'))});const commit=T.prototype.commit;
      T.prototype.commit=function(connection,value){return commit.call(this,connection,value).then(result=>{
        fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({acknowledged:true,first:fs.readFileSync(${JSON.stringify(first)},'utf8')}),{mode:0o600});
        process.kill(process.pid,'SIGKILL');return result;})};`;
    await withImportPreload('owned-s3-after-commit-crash', preload, async () => {
      expect(await restore()).toMatchObject({ restored: true, outcome: 'committed', restartRequired: true,
        filesRestored: remote.size + local.size });
    });
    expect(JSON.parse(await fs.readFile(evidence, 'utf8'))).toEqual({ acknowledged: true, first: 'BACKUP-A' });
    await restartStorage();
    expect(await readMarker()).toBe('backup');
    await assertRemoteEstate('backup'); await assertLocalEstate('backup');
    const control = await db('portable_restore_control').where({ id: 1 }).first();
    const commit = await db('portable_restore_commits').where({ attempt_id: control.attempt_id }).first();
    const index = await db('storage_s3_generation_index').where({ id: 1 }).first();
    expect(control.state).toBe('restart_required');
    expect(JSON.parse(control.result_json)).toMatchObject({ outcome: 'committed', recoveryAttempted: true });
    expect(index.revision).not.toBe(priorIndex.revision);
    expect(commit.s3_revision).toBe(index.revision);
    expect(commit.s3_namespace).toBe(index.namespace);
    expect(commit.s3_manifest_checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.mapping.size).toBe(remote.size);
    for (const [name, value] of remote) {
      expect(storage.mapping.get(name)).not.toBe(priorMapping.get(name));
      const old = await client.send(new GetObjectCommand({ Bucket: bucket,
        Key: `${storage.prefix}/${priorMapping.get(name)}` }));
      expect(await read(old.Body)).toEqual(value.prior);
    }
    await fs.unlink(evidence);
  }, 120000);
});
