const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const S3StorageBackend = require('../../src/services/storage/S3StorageBackend');

// MinIO defaults match docker-compose.dev.yml. Override via TEST_S3_* if needed.
const TEST_S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT || 'http://localhost:7104',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.TEST_S3_SECRET_KEY || 'minioadmin',
  region: 'us-east-1',
};

const skipS3 = process.env.SKIP_S3_TESTS === 'true';

// Build the matrix of backends to test. Local always runs; S3 runs against MinIO
// unless SKIP_S3_TESTS=true (CI default). The same suite runs against both so
// every consumer can rely on identical semantics.
function backendCases() {
  const cases = [
    {
      name: 'LocalFsStorage',
      async setup() {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-storage-'));
        const storage = new LocalFsStorage({ root });
        await storage.init();
        return { storage, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
      },
    },
  ];

  if (!skipS3) {
    cases.push({
      name: 'S3StorageBackend (MinIO)',
      async setup() {
        const bucket = `picpeak-test-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
        const s3Client = new S3Client({
          endpoint: TEST_S3.endpoint,
          region: TEST_S3.region,
          credentials: { accessKeyId: TEST_S3.accessKeyId, secretAccessKey: TEST_S3.secretAccessKey },
          forcePathStyle: true,
        });
        await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
        const storage = new S3StorageBackend({
          bucket,
          region: TEST_S3.region,
          endpoint: TEST_S3.endpoint,
          accessKeyId: TEST_S3.accessKeyId,
          secretAccessKey: TEST_S3.secretAccessKey,
          forcePathStyle: true,
          sslEnabled: false,
        });
        await storage.init();
        return {
          storage,
          async cleanup() {
            // Empty bucket then delete it.
            const list = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket }));
            if (list.Contents?.length) {
              await s3Client.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key })) },
              }));
            }
            await s3Client.send(new DeleteBucketCommand({ Bucket: bucket }));
          },
        };
      },
    });
  }

  return cases;
}

async function readToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

describe.each(backendCases())('StorageBackend contract: $name', ({ setup }) => {
  let storage;
  let cleanup;

  beforeAll(async () => {
    ({ storage, cleanup } = await setup());
  }, 30000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  test('put + get + exists + stat + delete round-trip with a buffer body', async () => {
    const key = 'photos/event-a/IMG_0001.jpg';
    const body = Buffer.from('hello picpeak');

    await storage.put(key, body, { contentType: 'image/jpeg' });

    expect(await storage.exists(key)).toBe(true);

    const stat = await storage.stat(key);
    expect(stat).not.toBeNull();
    expect(stat.size).toBe(body.length);

    const stream = await storage.get(key);
    const text = await readToString(stream);
    expect(text).toBe('hello picpeak');

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.stat(key)).toBeNull();
  });

  test('put accepts a Readable stream body', async () => {
    const key = 'photos/event-b/streamed.bin';
    const body = Readable.from(Buffer.from('streamed payload'));

    await storage.put(key, body);

    const got = await readToString(await storage.get(key));
    expect(got).toBe('streamed payload');
  });

  test('putFromFile + getToFile round-trip', async () => {
    const tmpIn = path.join(os.tmpdir(), `in-${Date.now()}.txt`);
    const tmpOut = path.join(os.tmpdir(), `out-${Date.now()}.txt`);
    await fsp.writeFile(tmpIn, 'file payload');

    const key = 'thumbnails/thumb_x.jpg';
    await storage.putFromFile(key, tmpIn, { contentType: 'image/jpeg' });

    await storage.getToFile(key, tmpOut);
    const text = await fsp.readFile(tmpOut, 'utf-8');
    expect(text).toBe('file payload');

    await fsp.unlink(tmpIn).catch(() => {});
    await fsp.unlink(tmpOut).catch(() => {});
  });

  test('list returns entries under a prefix with size + key', async () => {
    await storage.put('events/active/a/photo1.jpg', Buffer.from('a1'));
    await storage.put('events/active/a/photo2.jpg', Buffer.from('a22'));
    await storage.put('events/active/b/photo3.jpg', Buffer.from('b333'));

    const entries = await storage.list('events/active/a');
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(['events/active/a/photo1.jpg', 'events/active/a/photo2.jpg']);
    const sizes = Object.fromEntries(entries.map((e) => [e.key, e.size]));
    expect(sizes['events/active/a/photo1.jpg']).toBe(2);
    expect(sizes['events/active/a/photo2.jpg']).toBe(3);
  });

  test('rename moves an object from src to dst (atomic on local; copy+delete on s3)', async () => {
    await storage.put('uploads/temp.jpg', Buffer.from('rename-me'));
    await storage.rename('uploads/temp.jpg', 'uploads/final.jpg');

    expect(await storage.exists('uploads/temp.jpg')).toBe(false);
    expect(await storage.exists('uploads/final.jpg')).toBe(true);
    const text = await readToString(await storage.get('uploads/final.jpg'));
    expect(text).toBe('rename-me');
  });

  test('copy duplicates an object without removing the source', async () => {
    await storage.put('events/source.jpg', Buffer.from('src'));
    await storage.copy('events/source.jpg', 'events/copied.jpg');

    expect(await storage.exists('events/source.jpg')).toBe(true);
    expect(await storage.exists('events/copied.jpg')).toBe(true);
  });

  test('delete on a missing key is a no-op (does not throw)', async () => {
    await expect(storage.delete('does/not/exist.jpg')).resolves.toBeUndefined();
  });

  test('stat on a missing key returns null', async () => {
    expect(await storage.stat('still/not/here.jpg')).toBeNull();
  });

  test('rejects path traversal attempts', async () => {
    await expect(storage.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(/traversal/i);
    await expect(storage.get('../escape.txt')).rejects.toThrow(/traversal/i);
  });
});
