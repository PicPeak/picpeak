/**
 * sha256File: the one streaming SHA-256 the backup, database-dump, restore
 * and integrity code share (issue 2615).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sha256File } = require('../../src/utils/fileChecksum');

describe('sha256File', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-checksum-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the lowercase hex digest of the file contents', async () => {
    const file = path.join(dir, 'a.bin');
    const body = crypto.randomBytes(3 * 64 * 1024 + 17); // several stream chunks
    fs.writeFileSync(file, body);
    const digest = await sha256File(file);
    expect(digest).toBe(crypto.createHash('sha256').update(body).digest('hex'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes an empty file', async () => {
    const file = path.join(dir, 'empty');
    fs.writeFileSync(file, '');
    expect(await sha256File(file)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('rejects with ENOENT for a missing file', async () => {
    await expect(sha256File(path.join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects with EISDIR for a directory', async () => {
    await expect(sha256File(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
