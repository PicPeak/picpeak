/**
 * The chunked-upload per-file cap has to hold on the bytes actually received,
 * not on the client-declared `fileSize` the init route validates. Declaring
 * `fileSize: 1` and then streaming 10 GB through the chunk route was a
 * complete bypass of general_max_file_size_mb; the merge step only logged a
 * size mismatch and processed the file anyway.
 *
 * The chunk geometry is fixed by fileSize since the follow-up: every chunk
 * but the last is CHUNK_SIZE and the last is the remainder, so the cases
 * below declare sizes that match the chunks they send and lower or raise the
 * cap to provoke the limit.
 */
const path = require('path');
const os = require('os');
const fs = require('fs').promises;

process.env.STORAGE_PATH = path.join(os.tmpdir(), `picpeak-chunk-cap-test-${process.pid}`);

const chunkedUpload = require('../../src/services/chunkedUploadService');

const MB = 1024 * 1024;
const { CHUNK_SIZE } = chunkedUpload;

const init = (overrides = {}) => chunkedUpload.initializeUpload({
  filename: 'clip.mp4',
  fileSize: 1,
  mimeType: 'video/mp4',
  eventId: 1,
  totalChunks: 1,
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
    // Two full chunks declared against a cap that only has room for one and a half.
    const { uploadId } = await init({ fileSize: 2 * CHUNK_SIZE, totalChunks: 2, maxFileSizeBytes: 15 * MB });
    await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE));
    await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(CHUNK_SIZE)))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('counts a re-sent chunk once, not twice', async () => {
    // 10.3 MB in two chunks under an 11 MB cap: counting the re-sent first
    // chunk twice would read as 20.3 MB and trip it.
    const tail = 300 * 1024;
    const { uploadId } = await init({ fileSize: CHUNK_SIZE + tail, totalChunks: 2, maxFileSizeBytes: 11 * MB });
    await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE));
    // Same index again — replaces the earlier bytes, so the total stays 10 MB.
    await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE))).resolves.toBeTruthy();
    await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(tail))).resolves.toBeTruthy();
  });

  it('rejects chunk indices outside the announced range', async () => {
    const { uploadId } = await init();
    await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(10)))
      .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
    await expect(chunkedUpload.uploadChunk(uploadId, -1, Buffer.alloc(10)))
      .rejects.toMatchObject({ code: 'INVALID_CHUNK' });
    await expect(chunkedUpload.uploadChunk(uploadId, NaN, Buffer.alloc(10)))
      .rejects.toMatchObject({ code: 'INVALID_CHUNK' });
  });

  it('merges an upload under the cap and reports the real size', async () => {
    const { uploadId } = await init({ fileSize: 800 * 1024 });
    await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(800 * 1024, 0x41));
    const merged = await chunkedUpload.completeUpload(uploadId);
    expect(merged.size).toBe(800 * 1024);
    await fs.rm(merged.tempDir, { recursive: true, force: true });
  });

  it('applies no cap when none is given', async () => {
    const { uploadId } = await init({ maxFileSizeBytes: undefined, fileSize: 3 * MB });
    await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(3 * MB))).resolves.toBeTruthy();
    await chunkedUpload.abortUpload(uploadId);
  });
});
