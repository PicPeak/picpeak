const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { validateFileContent } = require('../../src/utils/fileSecurityUtils');

// Guest, chunked and v1 uploads now run validateFileContent, so a signature
// entry that refuses real files refuses them on every upload path.
let tmpDir;
const fixture = async (name, bytes) => {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
};
const ascii = (text) => [...Buffer.from(text, 'latin1')];
const box = (size, type, rest = []) => [0, 0, 0, size, ...ascii(type), ...rest];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-content-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('validateFileContent: GIF', () => {
  test('accepts GIF87a and GIF89a', async () => {
    expect(await validateFileContent(await fixture('a.gif', ascii('GIF87a\x01\x00\x01\x00')), 'image/gif')).toBe(true);
    expect(await validateFileContent(await fixture('b.gif', ascii('GIF89a\x01\x00\x01\x00')), 'image/gif')).toBe(true);
  });

  test('refuses a non-GIF', async () => {
    expect(await validateFileContent(await fixture('c.gif', ascii('GIF90a')), 'image/gif')).toBe(false);
  });
});

describe('validateFileContent: MP4 and QuickTime', () => {
  test('accepts an ftyp QuickTime file', async () => {
    const mov = await fixture('a.mov', [...box(20, 'ftyp', [...ascii('qt  '), 0, 0, 2, 0, ...ascii('qt  ')]), ...box(8, 'wide')]);
    expect(await validateFileContent(mov, 'video/quicktime')).toBe(true);
  });

  test('accepts a classic QuickTime file with no ftyp box', async () => {
    for (const atom of ['moov', 'mdat', 'wide']) {
      const mov = await fixture(`${atom}.mov`, [...box(8, atom), ...box(16, 'mdat', [1, 2, 3, 4, 5, 6, 7, 8])]);
      expect(await validateFileContent(mov, 'video/quicktime')).toBe(true);
    }
  });

  test('accepts a QuickTime file written with an ISO brand', async () => {
    const mov = await fixture('isom.mov', [...box(20, 'ftyp', [...ascii('isom'), 0, 0, 2, 0, ...ascii('mp41')]), ...box(8, 'free')]);
    expect(await validateFileContent(mov, 'video/quicktime')).toBe(true);
  });

  test('accepts an MP4 and refuses text or a HEIC named .mp4', async () => {
    const mp4 = await fixture('a.mp4', [...box(20, 'ftyp', [...ascii('isom'), 0, 0, 2, 0, ...ascii('mp42')]), ...box(8, 'free')]);
    expect(await validateFileContent(mp4, 'video/mp4')).toBe(true);
    expect(await validateFileContent(await fixture('t.mp4', ascii('hello world, not a video')), 'video/mp4')).toBe(false);
    const heic = await fixture('h.mp4', [...box(20, 'ftyp', [...ascii('heic'), 0, 0, 0, 0, ...ascii('mif1')]), ...box(8, 'meta')]);
    expect(await validateFileContent(heic, 'video/mp4')).toBe(false);
  });

  test('refuses a classic atom on an MP4', async () => {
    const file = await fixture('moov.mp4', [...box(8, 'moov'), ...box(8, 'mdat')]);
    expect(await validateFileContent(file, 'video/mp4')).toBe(false);
  });
});
