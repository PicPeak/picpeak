/**
 * The chunk geometry is fixed by the declared file size, and a completion
 * runs once.
 *
 * initializeUpload took `totalChunks` from the client as given, so
 * `totalChunks: 1` for any fileSize made a single chunk carry the whole
 * per-file allowance (up to the 10 GB ceiling), and completeUpload then
 * read that chunk into one Buffer. completeUpload also set status
 * 'merging' without ever checking it, so parallel completions each merged
 * their own full copy.
 *
 * Pins:
 *  - totalChunks must equal ceil(fileSize / CHUNK_SIZE), and is bounded
 *  - every chunk but the last is exactly CHUNK_SIZE; the last is the remainder
 *  - a chunk of the wrong size is refused without aborting the upload, and
 *    before its body is read when it announces its size
 *  - the merge streams the chunks (no readFile) and requires the merged size
 *    to be the declared one
 *  - of several concurrent completions exactly one merges; the rest get 409
 */
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const { Readable } = require('stream');

process.env.STORAGE_PATH = path.join(os.tmpdir(), `picpeak-chunk-geometry-test-${process.pid}`);

const chunkedUpload = require('../../src/services/chunkedUploadService');

const MB = 1024 * 1024;
const { CHUNK_SIZE } = chunkedUpload;

const init = (overrides = {}) => chunkedUpload.initializeUpload({
  filename: 'clip.mp4',
  mimeType: 'video/mp4',
  eventId: 1,
  maxFileSizeBytes: 100 * MB,
  ...overrides,
});

function countingSource(totalBytes, sliceSize = 64 * 1024) {
  let remaining = totalBytes;
  const source = new Readable({
    read() {
      if (remaining <= 0) return this.push(null);
      const n = Math.min(sliceSize, remaining);
      remaining -= n;
      source.bytesRead += n;
      this.push(Buffer.alloc(n));
    },
  });
  source.bytesRead = 0;
  return source;
}

describe('chunked upload geometry', () => {
  afterAll(async () => {
    await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true }).catch(() => {});
  });

  describe('initializeUpload', () => {
    it('derives the chunk count from the file size', async () => {
      const res = await init({ fileSize: 2 * CHUNK_SIZE + 1 });
      expect(res.expectedChunks).toBe(3);
      expect(res.chunkSize).toBe(CHUNK_SIZE);
      await chunkedUpload.abortUpload(res.uploadId);
    });

    it('refuses a totalChunks that does not match the file size', async () => {
      await expect(init({ fileSize: 3 * CHUNK_SIZE, totalChunks: 1 }))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      await expect(init({ fileSize: 1024, totalChunks: 2 }))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
    });

    it('accepts a totalChunks that does match', async () => {
      const res = await init({ fileSize: 3 * CHUNK_SIZE, totalChunks: 3 });
      expect(res.expectedChunks).toBe(3);
      await chunkedUpload.abortUpload(res.uploadId);
    });

    it('refuses a file size that is not a positive integer', async () => {
      for (const fileSize of [0, -1, 1.5, 'abc', undefined]) {
        await expect(init({ fileSize })).rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      }
    });

    it('bounds the chunk count at the 10 GB ceiling', async () => {
      await expect(init({ fileSize: 11 * 1024 * MB, maxFileSizeBytes: undefined }))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
    });
  });

  describe('uploadChunk', () => {
    it('requires every chunk but the last to be exactly CHUNK_SIZE', async () => {
      const { uploadId } = await init({ fileSize: CHUNK_SIZE + 10 });
      await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE - 1)))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE + 1)))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      // Not aborted: the client can re-send at the right size.
      expect(chunkedUpload.getUploadStatus(uploadId)).not.toBeNull();
      await expect(chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE))).resolves.toBeTruthy();
    });

    it('requires the last chunk to be exactly the remainder', async () => {
      const { uploadId } = await init({ fileSize: CHUNK_SIZE + 10 });
      await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(9)))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK' });
      await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(11)))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK' });
      await expect(chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(10))).resolves.toBeTruthy();
    });

    it('refuses a wrongly sized chunk before reading it when it announces its size', async () => {
      const { uploadId } = await init({ fileSize: 1024 });
      const source = countingSource(2048);
      await expect(chunkedUpload.uploadChunk(uploadId, 0, source, { declaredBytes: 2048 }))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      expect(source.bytesRead).toBe(0);
    });

    it('stops reading a body that overshoots its chunk size, inside the per-file cap', async () => {
      // 1 KB chunk against a 100 MB cap: the chunk size is the tighter bound,
      // so the 8 MB body is cut off at the chunk size and refused as a protocol
      // error, not as a cap violation — and the upload survives.
      const { uploadId } = await init({ fileSize: 1024 });
      const source = countingSource(8 * MB);
      await expect(chunkedUpload.uploadChunk(uploadId, 0, source))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      expect(source.bytesRead).toBeLessThan(1 * MB);
      expect(chunkedUpload.getUploadStatus(uploadId)).not.toBeNull();
      const leftovers = await fs.readdir(path.join(process.env.STORAGE_PATH, 'chunks', uploadId));
      expect(leftovers).toEqual([]);
    });

    it('refuses a short body and leaves nothing behind', async () => {
      const { uploadId } = await init({ fileSize: 1024 });
      await expect(chunkedUpload.uploadChunk(uploadId, 0, countingSource(512)))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      const leftovers = await fs.readdir(path.join(process.env.STORAGE_PATH, 'chunks', uploadId));
      expect(leftovers).toEqual([]);
      expect(chunkedUpload.getUploadStatus(uploadId).receivedChunks).toBe(0);
    });
  });

  describe('completeUpload', () => {
    const fullUpload = async (tail = 10) => {
      const { uploadId } = await init({ fileSize: CHUNK_SIZE + tail });
      await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE, 0x41));
      await chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(tail, 0x42));
      return uploadId;
    };

    it('streams the chunks into the merged file instead of reading them whole', async () => {
      const uploadId = await fullUpload();
      const readFile = jest.spyOn(fs, 'readFile');
      const merged = await chunkedUpload.completeUpload(uploadId);
      expect(readFile).not.toHaveBeenCalled();
      readFile.mockRestore();

      expect(merged.size).toBe(CHUNK_SIZE + 10);
      const bytes = await fs.readFile(merged.path);
      expect(bytes.length).toBe(CHUNK_SIZE + 10);
      expect(bytes[0]).toBe(0x41);
      expect(bytes[CHUNK_SIZE]).toBe(0x42);
      await fs.rm(merged.tempDir, { recursive: true, force: true });
    });

    it('hands the upload back as in_progress when the merge directory cannot be created', async () => {
      const uploadId = await fullUpload();
      const mkdir = jest.spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
      await expect(chunkedUpload.completeUpload(uploadId)).rejects.toThrow('ENOSPC');
      mkdir.mockRestore();

      // Not stuck in 'merging': the next completion attempt goes through.
      expect(chunkedUpload.getUploadStatus(uploadId).status).toBe('in_progress');
      const merged = await chunkedUpload.completeUpload(uploadId);
      expect(merged.size).toBe(CHUNK_SIZE + 10);
      await fs.rm(merged.tempDir, { recursive: true, force: true });
    });

    it('lets exactly one of several concurrent completions merge; the rest get 409', async () => {
      const uploadId = await fullUpload();
      const results = await Promise.allSettled([
        chunkedUpload.completeUpload(uploadId),
        chunkedUpload.completeUpload(uploadId),
        chunkedUpload.completeUpload(uploadId),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(2);
      for (const r of refused) {
        expect(r.reason).toMatchObject({ code: 'UPLOAD_STATE', statusCode: 409 });
        expect(r.reason.message).toMatch(/merging/);
      }
      await fs.rm(ok[0].value.tempDir, { recursive: true, force: true });
    });

    it('refuses a merged file whose size is not the declared one', async () => {
      const uploadId = await fullUpload();
      // Tamper with a chunk on disk after it was accepted.
      const chunkPath = path.join(process.env.STORAGE_PATH, 'chunks', uploadId, 'chunk_000001');
      await fs.writeFile(chunkPath, Buffer.alloc(11));
      await expect(chunkedUpload.completeUpload(uploadId))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      expect(chunkedUpload.getUploadStatus(uploadId)).toBeNull();
    });
  });
});
