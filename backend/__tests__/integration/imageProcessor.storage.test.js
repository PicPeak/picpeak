const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const S3StorageBackend = require('../../src/services/storage/S3StorageBackend');
const storageModule = require('../../src/services/storage');

// Stub out the DB so getThumbnailSettings falls into its catch and uses defaults.
jest.mock('../../src/database/db', () => ({
  db: () => {
    throw new Error('db disabled in this test');
  },
}));

const TEST_S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT || 'http://localhost:7104',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.TEST_S3_SECRET_KEY || 'minioadmin',
  region: 'us-east-1',
};

const skipS3 = process.env.SKIP_S3_TESTS === 'true';

function backendCases() {
  const cases = [
    {
      name: 'LocalFsStorage',
      async setup() {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-imgproc-'));
        const storage = new LocalFsStorage({ root });
        await storage.init();
        return { storage, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
      },
    },
  ];
  if (!skipS3) {
    cases.push({
      name: 'S3StorageBackend (MinIO)',
      async setup() {
        const bucket = `picpeak-imgproc-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
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

async function makeSourceJpeg(targetDir, name) {
  const localPath = path.join(targetDir, name);
  // 800x600 random RGB image so sharp has something realistic to thumbnail.
  const width = 800;
  const height = 600;
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 256;
  await sharp(buf, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(localPath);
  return localPath;
}

describe.each(backendCases())('imageProcessor through $name', ({ setup }) => {
  let storage;
  let cleanup;
  let tmpDir;
  let imageProcessor;

  beforeAll(async () => {
    ({ storage, cleanup } = await setup());
    storageModule.setStorageForTesting(storage);
    // Require AFTER setStorageForTesting so the module sees our injection.
    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-imgproc-src-'));
  }, 30000);

  afterAll(async () => {
    storageModule.resetStorage();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (cleanup) await cleanup();
  });

  test('generateThumbnail writes through storage and returns a relative key', async () => {
    const src = await makeSourceJpeg(tmpDir, 'sample.jpg');
    const key = await imageProcessor.generateThumbnail(src);
    expect(key).toBe('thumbnails/thumb_sample.jpg');

    expect(await storage.exists(key)).toBe(true);
    const stat = await storage.stat(key);
    expect(stat.size).toBeGreaterThan(100);

    // Verify the bytes are a valid JPEG by re-parsing with sharp on local mode.
    if (storage.kind() === 'local') {
      const meta = await sharp(storage.resolveLocalPath(key)).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeLessThanOrEqual(300);
    }
  });

  test('generateHeroImage writes through storage and returns a relative key', async () => {
    const src = await makeSourceJpeg(tmpDir, 'hero-source.jpg');
    const key = await imageProcessor.generateHeroImage(src);
    expect(key).toBe('heroes/hero_hero-source.jpg');
    expect(await storage.exists(key)).toBe(true);
  });

  test('generatePreviewImage writes to /previews and skips enlargement of small originals', async () => {
    const src = await makeSourceJpeg(tmpDir, 'preview-source.jpg');
    const key = await imageProcessor.generatePreviewImage(src);
    expect(key).toBe('previews/preview_preview-source.jpg');
    expect(await storage.exists(key)).toBe(true);

    if (storage.kind() === 'local') {
      const meta = await sharp(storage.resolveLocalPath(key)).metadata();
      expect(meta.format).toBe('jpeg');
      // Source is 800x600 and default longEdge is 1920 with
      // withoutEnlargement: true → preview must NOT be upscaled.
      expect(meta.width).toBe(800);
      expect(meta.height).toBe(600);
    }
  });

  test('generatePreviewImage shrinks oversized images to fit longEdge while preserving aspect', async () => {
    const src = await makeSourceJpeg(tmpDir, 'preview-shrink.jpg');
    const key = await imageProcessor.generatePreviewImage(src, { longEdge: 400 });
    expect(await storage.exists(key)).toBe(true);
    if (storage.kind() === 'local') {
      const meta = await sharp(storage.resolveLocalPath(key)).metadata();
      // 800x600 → fit:'inside' inside 400×400 → 400×300.
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(300);
    }
  });

  test('isPreviewValid returns true for a real preview and false for a missing key', async () => {
    const src = await makeSourceJpeg(tmpDir, 'preview-valid.jpg');
    const key = await imageProcessor.generatePreviewImage(src);
    expect(await imageProcessor.isPreviewValid(key)).toBe(true);
    expect(await imageProcessor.isPreviewValid('previews/does-not-exist.jpg')).toBe(false);
  });

  test('isThumbnailValid returns true for a good thumbnail and false for nothing', async () => {
    const src = await makeSourceJpeg(tmpDir, 'valid-check.jpg');
    const key = await imageProcessor.generateThumbnail(src);
    expect(await imageProcessor.isThumbnailValid(key)).toBe(true);
    expect(await imageProcessor.isThumbnailValid('thumbnails/does-not-exist.jpg')).toBe(false);
  });

  test('generateVideoPlaceholder writes a thumbnail entirely from buffer', async () => {
    const key = await imageProcessor.generateVideoPlaceholder('demo.mp4');
    expect(key).toBe('thumbnails/thumb_demo.jpg');
    expect(await storage.exists(key)).toBe(true);
  });

  test('withLocalCopy yields a usable local path on both backends', async () => {
    const sourceKey = 'fixture/withlocal.jpg';
    const src = await makeSourceJpeg(tmpDir, 'withlocal.jpg');
    const buf = await fs.readFile(src);
    await storage.put(sourceKey, buf, { contentType: 'image/jpeg' });

    const seenSize = await imageProcessor.withLocalCopy(sourceKey, async (localPath) => {
      const meta = await sharp(localPath).metadata();
      return meta.width;
    });
    expect(seenSize).toBe(800);
  });
});
