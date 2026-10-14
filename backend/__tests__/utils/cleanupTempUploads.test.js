/**
 * cleanupTempUploads also clears the chunk and merge directories of chunked
 * uploads that ran without an upload admission. The expiry sweep only knows
 * the uploads in its in-memory map, so after a restart nothing else did.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('cleanupTempUploads: stale chunked upload directories', () => {
  const previous = process.env.STORAGE_PATH;
  let root;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-temp-sweep-'));
    process.env.STORAGE_PATH = root;
  });

  afterEach(async () => {
    process.env.STORAGE_PATH = previous;
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function makeDir(rel, ageMs) {
    const dir = path.join(root, rel);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'chunk_000000'), 'x');
    const at = new Date(Date.now() - ageMs);
    await fs.promises.utimes(dir, at, at);
    return dir;
  }

  const exists = (dir) => fs.promises.access(dir).then(() => true, () => false);
  const DAY = 24 * 60 * 60 * 1000;

  it('removes chunk and merge directories older than a day and keeps newer ones', async () => {
    const oldChunks = await makeDir('chunks/old-upload', DAY + 60000);
    const newChunks = await makeDir('chunks/new-upload', 60000);
    const oldMerge = await makeDir(`temp/merge_${Date.now() - DAY - 60000}_abc`, 0);
    const newMerge = await makeDir(`temp/merge_${Date.now() - 60000}_def`, 0);
    // Staged by the upload quota, which reaps it by its own lease.
    const staged = await makeDir('temp/public-uploads/some-request', DAY + 60000);

    const { cleanupTempUploads } = require('../../src/utils/cleanupTempUploads');
    await cleanupTempUploads();

    expect(await exists(oldChunks)).toBe(false);
    expect(await exists(oldMerge)).toBe(false);
    expect(await exists(newChunks)).toBe(true);
    expect(await exists(newMerge)).toBe(true);
    expect(await exists(staged)).toBe(true);
  });

  it('does nothing when neither directory exists', async () => {
    const { cleanupTempUploads } = require('../../src/utils/cleanupTempUploads');
    await expect(cleanupTempUploads()).resolves.toBeUndefined();
  });
});
