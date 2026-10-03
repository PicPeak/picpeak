/**
 * A rejected chunk must not cost its own size in memory (#1403).
 *
 * The route used to drain the whole request into an array and `Buffer.concat`
 * it before calling uploadChunk, which is where every check lives — the
 * per-file cap, the chunk index, and even "does this upload id exist". So a
 * 300MB body against an unknown upload id was read in full, added ~300MB to
 * RSS, and was then answered with an error. The size cap was real but only
 * applied after the damage.
 *
 * The contract these tests pin: uploadChunk consumes NOTHING until every check
 * has passed, and once it does start reading it stops at the remaining
 * allowance rather than trusting the sender.
 *
 * The chunk geometry is fixed by fileSize since the follow-up (every chunk
 * but the last is CHUNK_SIZE, the last is the remainder), so each case
 * declares a size that matches the chunks it sends. The default is a
 * one-chunk file exactly as large as the 1 MB cap, so a sender that
 * overshoots trips the cap first.
 */
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const { Readable } = require('stream');

process.env.STORAGE_PATH = path.join(os.tmpdir(), `picpeak-chunk-stream-test-${process.pid}`);

const chunkedUpload = require('../../src/services/chunkedUploadService');

const MB = 1024 * 1024;
const { CHUNK_SIZE } = chunkedUpload;

const init = (overrides = {}) => chunkedUpload.initializeUpload({
  filename: 'clip.mp4',
  fileSize: 1 * MB,
  mimeType: 'video/mp4',
  eventId: 1,
  maxFileSizeBytes: 1 * MB,
  ...overrides,
});

/**
 * A readable that reports how much of it was actually pulled. Bytes are
 * generated lazily, so "never read" really means the body never materialized.
 */
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

describe('chunked upload streams the body under a cap (#1403)', () => {
  afterAll(async () => {
    await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true }).catch(() => {});
  });

  describe('refused before the body is read', () => {
    it('reads nothing for an unknown upload id', async () => {
      const source = countingSource(8 * MB);
      await expect(chunkedUpload.uploadChunk('does-not-exist', 0, source, { declaredBytes: 8 * MB }))
        .rejects.toThrow('Upload not found or expired');
      expect(source.bytesRead).toBe(0);
    });

    it('reads nothing for an out-of-range chunk index', async () => {
      const { uploadId } = await init();
      const source = countingSource(8 * MB);
      await expect(chunkedUpload.uploadChunk(uploadId, 99, source, { declaredBytes: 8 * MB }))
        .rejects.toMatchObject({ code: 'INVALID_CHUNK', statusCode: 400 });
      expect(source.bytesRead).toBe(0);
    });

    it('reads nothing when Content-Length already exceeds the cap', async () => {
      const { uploadId } = await init();
      const source = countingSource(8 * MB);
      await expect(chunkedUpload.uploadChunk(uploadId, 0, source, { declaredBytes: 8 * MB }))
        .rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 413 });
      expect(source.bytesRead).toBe(0);
      expect(chunkedUpload.getUploadStatus(uploadId)).toBeNull();
    });

    it('counts what earlier chunks already banked when checking Content-Length', async () => {
      const { uploadId } = await init({ fileSize: 2 * CHUNK_SIZE, maxFileSizeBytes: 15 * MB });
      await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE));
      const source = countingSource(CHUNK_SIZE);
      // 10MB banked + 10MB declared > the 15MB cap.
      await expect(chunkedUpload.uploadChunk(uploadId, 1, source, { declaredBytes: CHUNK_SIZE }))
        .rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 413 });
      expect(source.bytesRead).toBe(0);
    });
  });

  describe('a sender that lies, or says nothing', () => {
    it('stops at the allowance instead of reading the whole body', async () => {
      const { uploadId } = await init();
      // No declaredBytes at all — the Transfer-Encoding: chunked case.
      const source = countingSource(8 * MB);
      await expect(chunkedUpload.uploadChunk(uploadId, 0, source))
        .rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 413 });
      // The overshoot is whatever the readable had already buffered ahead when
      // the cap tripped — a small constant tied to highWaterMark, NOT a
      // function of the body size. That is the whole claim: 8MB offered, ~1MB
      // read. The slack is deliberately loose so this doesn't turn into a
      // Node-version canary.
      expect(source.bytesRead).toBeLessThan(2 * MB);
    });

    it('leaves no partial chunk file behind when it cuts a body off', async () => {
      const { uploadId } = await init();
      const meta = chunkedUpload.getUploadStatus(uploadId);
      await expect(chunkedUpload.uploadChunk(uploadId, 0, countingSource(8 * MB)))
        .rejects.toMatchObject({ statusCode: 413 });
      // abortUpload removes the whole directory; assert nothing survived it.
      await expect(fs.readdir(path.join(process.env.STORAGE_PATH, 'chunks', uploadId)))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(meta).not.toBeNull();
    });
  });

  // Every case here was found by an external review of the first cut of this
  // fix. All three are regressions the buffered version did not have: the
  // async iterator it replaced rejected a dead request on its own, and never
  // opened the chunk file at all until it had the whole body in hand.
  describe('failure paths the streaming rewrite introduced', () => {
    it('rejects an already-destroyed request instead of hanging forever', async () => {
      const { uploadId } = await init();
      const source = countingSource(1024);
      source.destroy();
      // pipe() on a dead stream emits neither `end` nor `error`, so without an
      // explicit check this promise never settles and the write fd leaks.
      await expect(chunkedUpload.uploadChunk(uploadId, 0, source))
        .rejects.toMatchObject({ code: 'CHUNK_PREMATURE_CLOSE', statusCode: 400 });
    });

    it('leaves a previously banked chunk intact when a re-send fails', async () => {
      const { uploadId } = await init({ fileSize: 1000 });
      await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(1000));
      const chunkPath = path.join(process.env.STORAGE_PATH, 'chunks', uploadId, 'chunk_000000');
      expect((await fs.stat(chunkPath)).size).toBe(1000);

      // Re-send the same index, then fail it mid-flight.
      const source = new Readable({ read() {} });
      const pending = chunkedUpload.uploadChunk(uploadId, 0, source);
      source.push(Buffer.alloc(10));
      source.destroy(new Error('client went away'));
      await expect(pending).rejects.toThrow();

      // The banked copy must still be there: receivedChunks/chunkSizes still
      // count it, so a truncated file here means status reports 100% and
      // completeUpload dies on ENOENT.
      expect((await fs.stat(chunkPath)).size).toBe(1000);
      // Still counted as received — which is exactly why the file has to still
      // be there and be the full 1000 bytes.
      expect(chunkedUpload.getUploadStatus(uploadId).receivedChunks).toBe(1);
    });

    it('keeps two in-flight sends of the same chunk off each other\'s staging file', async () => {
      const { uploadId } = await init({ fileSize: 10 });
      const chunkPath = path.join(process.env.STORAGE_PATH, 'chunks', uploadId, 'chunk_000000');

      // Two requests for the same index, overlapping. A shared .part path let
      // whichever renamed first publish bytes the other had already truncated.
      const slow = new Readable({ read() {} });
      const doomed = new Readable({ read() {} });
      const slowDone = chunkedUpload.uploadChunk(uploadId, 0, slow);
      const doomedDone = chunkedUpload.uploadChunk(uploadId, 0, doomed);

      doomed.push(Buffer.alloc(2));
      doomed.destroy(new Error('retry gave up'));
      await expect(doomedDone).rejects.toThrow();

      slow.push(Buffer.alloc(10));
      slow.push(null);
      await expect(slowDone).resolves.toBeTruthy();

      // The surviving attempt's 10 bytes, not the failed one's 2.
      expect((await fs.stat(chunkPath)).size).toBe(10);
    });

    it('leaves no staging files behind after a failure', async () => {
      const { uploadId } = await init();
      await expect(chunkedUpload.uploadChunk(uploadId, 0, countingSource(8 * MB)))
        .rejects.toMatchObject({ statusCode: 413 });
      // The cap path aborts the whole upload, so the directory is gone; what
      // must not happen is a .part file reappearing after cleanup because the
      // write stream's open() was still pending when the unlink ran.
      await new Promise((r) => setTimeout(r, 50));
      await expect(fs.readdir(path.join(process.env.STORAGE_PATH, 'chunks', uploadId)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('counts chunks that landed while another was still streaming', async () => {
      const { uploadId } = await init({ fileSize: 3 * CHUNK_SIZE, maxFileSizeBytes: 15 * MB });

      // Start a slow 10MB chunk. Its allowance is computed now, when nothing
      // else is banked.
      const slow = new Readable({ read() {} });
      const slowDone = chunkedUpload.uploadChunk(uploadId, 0, slow);

      // A second 10MB chunk completes in the meantime.
      await chunkedUpload.uploadChunk(uploadId, 1, Buffer.alloc(CHUNK_SIZE));

      // Finishing the first must not publish: 20MB against a 15MB cap.
      slow.push(Buffer.alloc(CHUNK_SIZE));
      slow.push(null);
      await expect(slowDone).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', statusCode: 413 });
      expect(chunkedUpload.getUploadStatus(uploadId)).toBeNull();
    });

    it('removes the staging file when publishing it fails', async () => {
      const { uploadId } = await init({ fileSize: 1024 });
      const dir = path.join(process.env.STORAGE_PATH, 'chunks', uploadId);
      // Make the rename fail by putting a directory where the chunk goes.
      await fs.mkdir(path.join(dir, 'chunk_000000'), { recursive: true });

      await expect(chunkedUpload.uploadChunk(uploadId, 0, countingSource(1024)))
        .rejects.toThrow();

      // The fully written .part must not survive a failed publish — its name is
      // per-attempt, so retries would otherwise pile them up until expiry.
      const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.part'));
      expect(leftovers).toEqual([]);
    });

    it('does not destroy the request stream when it trips the cap', async () => {
      const { uploadId } = await init();
      const source = countingSource(8 * MB);
      await expect(chunkedUpload.uploadChunk(uploadId, 0, source))
        .rejects.toMatchObject({ statusCode: 413 });
      // `source` stands in for the IncomingMessage. Destroying it would take
      // the socket down before the route could send its 413 JSON, so the client
      // would see a connection reset instead of the error.
      expect(source.destroyed).toBe(false);
    });
  });

  // These were plain Errors, so the routes answered 500 for what are plainly
  // client mistakes — a backend fault in monitoring, and an invitation to
  // retry something that can never succeed.
  describe('client-caused states carry their own status code', () => {
    it('404s an unknown upload id rather than 500', async () => {
      await expect(chunkedUpload.uploadChunk('does-not-exist', 0, Buffer.alloc(10)))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    // 409 (wrong status) and 410 (expired) share uploadStateError with the two
    // covered here. Reaching them from the public surface needs either a clock
    // or a setter the service does not expose, and a test that pretends to
    // exercise them while actually hitting the 404 path is worse than none.

    it('404s completing an unknown upload rather than 500', async () => {
      await expect(chunkedUpload.completeUpload('does-not-exist'))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    it('400s completing an upload that is missing chunks', async () => {
      const { uploadId } = await init({ fileSize: 2 * CHUNK_SIZE, maxFileSizeBytes: 25 * MB });
      await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(CHUNK_SIZE));
      await expect(chunkedUpload.completeUpload(uploadId))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('the happy path still works', () => {
    it('writes a streamed chunk and reports progress', async () => {
      // Two chunks; the streamed one is the 0.25MB tail.
      const { uploadId } = await init({ fileSize: CHUNK_SIZE + 0.25 * MB, maxFileSizeBytes: 25 * MB });
      const result = await chunkedUpload.uploadChunk(uploadId, 1, countingSource(0.25 * MB), {
        declaredBytes: 0.25 * MB,
      });
      expect(result).toMatchObject({ chunkIndex: 1, received: 1, expected: 2, complete: false });

      const chunkPath = path.join(process.env.STORAGE_PATH, 'chunks', uploadId, 'chunk_000001');
      expect((await fs.stat(chunkPath)).size).toBe(0.25 * MB);
    });

    it('still accepts a Buffer, the shape the service was written for', async () => {
      const { uploadId } = await init({ fileSize: 0.25 * MB });
      const result = await chunkedUpload.uploadChunk(uploadId, 0, Buffer.alloc(0.25 * MB));
      expect(result).toMatchObject({ chunkIndex: 0, received: 1 });
    });

    it('lets a re-sent chunk replace itself without double-counting', async () => {
      const size = 600 * 1024;
      const { uploadId } = await init({ fileSize: size });
      await chunkedUpload.uploadChunk(uploadId, 0, countingSource(size), { declaredBytes: size });
      // Same index again: the first copy's 600KB must not count toward the cap.
      await expect(
        chunkedUpload.uploadChunk(uploadId, 0, countingSource(size), { declaredBytes: size }),
      ).resolves.toBeTruthy();
    });
  });
});
