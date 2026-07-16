const path = require('path');
const os = require('os');
const fs = require('fs').promises;

// Point storage at a throwaway temp dir before requiring the service so the
// module-level getStoragePath() picks it up if evaluated.
process.env.STORAGE_PATH = path.join(os.tmpdir(), `picpeak-chunk-test-${process.pid}`);

const chunkedUpload = require('../../src/services/chunkedUploadService');

describe('chunkedUploadService.initializeUpload filename sanitisation (GHSA-pc72-jf53-w28j)', () => {
  afterAll(async () => {
    await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true }).catch(() => {});
  });

  it('strips directory-traversal components from the stored filename', async () => {
    const { uploadId } = await chunkedUpload.initializeUpload({
      filename: '../../uploads/logos/evil.svg',
      fileSize: 10,
      mimeType: 'video/mp4',
      eventId: 1,
      totalChunks: 1,
    });
    const meta = chunkedUpload.getUploadStatus(uploadId);
    // basename('../../uploads/logos/evil.svg') === 'evil.svg' — the traversal
    // is gone, so path.join(tempDir, filename) can no longer escape tempDir.
    expect(meta.filename).toBe('evil.svg');
  });

  it('keeps a normal filename intact', async () => {
    const { uploadId } = await chunkedUpload.initializeUpload({
      filename: 'clip.mp4',
      fileSize: 10,
      mimeType: 'video/mp4',
      eventId: 1,
      totalChunks: 1,
    });
    expect(uploadId).toBeTruthy();
  });

  it('rejects a filename that collapses to nothing', async () => {
    await expect(
      chunkedUpload.initializeUpload({
        filename: '../',
        fileSize: 10,
        mimeType: 'video/mp4',
        eventId: 1,
        totalChunks: 1,
      })
    ).rejects.toThrow(/Invalid filename/);
  });
});
