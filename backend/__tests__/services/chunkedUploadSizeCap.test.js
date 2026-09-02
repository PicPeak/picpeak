/**
 * The chunked-upload per-file cap has to hold on the bytes actually received,
 * not on the client-declared `fileSize` the init route validates. Declaring
 * `fileSize: 1` and then streaming 10 GB through the chunk route was a
 * complete bypass of general_max_file_size_mb; the merge step only logged a
 * size mismatch and processed the file anyway.
 */
const path = require('path');
const os = require('os');
const fs = require('fs').promises;

process.env.STORAGE_PATH = path.join(os.tmpdir(), `picpeak-chunk-cap-test-${process.pid}`);

const chunkedUpload = require('../../src/services/chunkedUploadService');

const MB = 1024 * 1024;

const init = (overrides = {}) => chunkedUpload.initializeUpload({
  filename: 'clip.mp4',
  fileSize: 1,
  mimeType: 'video/mp4',
  eventId: 1,
  totalChunks: 2,
  maxFileSizeBytes: 1 * MB,
  ...overrides,
});

describe('chunkedUploadService per-file size cap', () => {
  afterAll(async () => {
    await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a single chunk over the cap even when the declared fileSize is tiny', async () => {
    const { uploadId } = await init();
    await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(2 * MB)))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 413 });
    // Aborted, not merely rejected: the upload can no longer be completed.
    expect(chunkedUpload.getUploadStatus(uploadId)).toBeNull();
  });

  it('rejects when the running total across chunks crosses the cap', async () => {
    const { uploadId } = await init();
    await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(0.75 * MB));
    await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(0.5 * MB)))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('counts a re-sent chunk once, not twice', async () => {
    const { uploadId } = await init();
    await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(0.6 * MB));
    // Same index again — replaces the earlier bytes, so the total stays 0.6 MB.
    await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(0.6 * MB))).resolves.toBeTruthy();
    await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(0.3 * MB))).resolves.toBeTruthy();
  });

  it('rejects chunk indices outside the announced range', async () => {
    const { uploadId } = await init();
    await expect(chunkedUpload.uploadChunk(uploadId, 2, Buffer.alloc(10)))
      .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
    await expect(chunkedUpload.uploadChunk(uploadId, -1, Buffer.alloc(10)))
      .rejects.toMatchObject({ code: 'INVALID_CHUNK' });
    await expect(chunkedUpload.uploadChunk(uploadId, NaN, Buffer.alloc(10)))
      .rejects.toMatchObject({ code: 'INVALID_CHUNK' });
  });

  it('merges an upload under the cap and reports the real size', async () => {
    const { uploadId } = await init();
    await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(400 * 1024, 0x41));
    await chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(400 * 1024, 0x42));
    const merged = await chunkedUpload.completeUpload(uploadId);
    expect(merged.size).toBe(800 * 1024);
    await fs.rm(merged.tempDir, { recursive: true, force: true });
  });

  it('applies no cap when none is given', async () => {
    const { uploadId } = await init({ maxFileSizeBytes: undefined, totalChunks: 1 });
    await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(3 * MB))).resolves.toBeTruthy();
    await chunkedUpload.abortUpload(uploadId);
  });
});
