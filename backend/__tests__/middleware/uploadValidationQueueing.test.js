// The decode check runs while a request waits: it carries the upload's
// cancellation signal, and is not interactive work, because a full queue
// would answer busy and "busy" keeps a file unchecked.
const fs = require('fs');
const os = require('os');
const path = require('path');

const calls = [];
jest.mock('../../src/services/isolatedSharp', () => {
  const fn = jest.fn((input, options) => {
    calls.push(options);
    return {
      metadata: jest.fn().mockResolvedValue({ width: 32, height: 32 }),
      resize: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.alloc(1)),
    };
  });
  fn.metadataBatch = jest.fn();
  return fn;
});

const { validateUploadedFiles } = require('../../src/middleware/uploadValidation');

describe('validateUploadedFiles queueing', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-uv-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { calls.length = 0; });

  it('submits the decode with the upload signal, never as interactive work', async () => {
    const file = path.join(dir, 'staged');
    fs.writeFileSync(file, 'x');
    const signal = new AbortController().signal;
    const req = { files: [{ originalname: 'a.jpg', path: file }], publicUploadReservation: { signal } };
    await validateUploadedFiles(req, {}, () => {});
    expect(req.files).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) {
      expect(options).toMatchObject({ signal });
      expect(options.interactive).toBeFalsy();
    }
  });

  it('decodes by the declared type when the name has no image extension', async () => {
    const file = path.join(dir, 'upload.bin');
    fs.writeFileSync(file, 'x');
    await validateUploadedFiles({ files: [{ originalname: 'upload.bin', path: file, mimetype: 'image/jpeg' }] }, {}, () => {});
    expect(calls.length).toBeGreaterThan(0);
  });

  it('leaves a non-decodable type alone', async () => {
    const file = path.join(dir, 'clip.mov');
    fs.writeFileSync(file, 'x');
    await validateUploadedFiles({ files: [{ originalname: 'clip.mov', path: file, mimetype: 'video/quicktime' }] }, {}, () => {});
    expect(calls).toHaveLength(0);
  });
});
