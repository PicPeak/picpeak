/**
 * What a request sees when the image worker refuses on-demand work: "not now"
 * is a 503 with Retry-After, and an image over the limits falls back the way
 * an unreadable source always has.
 */
const refusal = (code, extra) => Object.assign(new Error(`worker says ${code}`), { code }, extra);

describe('errorResponse', () => {
  jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
  const { errorResponse } = require('../../src/utils/routeHelpers');
  const response = () => {
    const res = { headers: {}, set(values) { Object.assign(res.headers, values); return res; },
      status(code) { res.statusCode = code; return res; }, json(body) { res.body = body; return res; } };
    return res;
  };

  test.each(['IMAGE_QUEUE_FULL', 'IMAGE_WORKER_UNAVAILABLE', 'IMAGE_TIMEOUT', 'IMAGE_CANCELLED'])('%s is answered 503 with Retry-After', code => {
    const res = response();
    errorResponse(res, refusal(code, { retryAfter: 7 }), 500, 'Failed to serve thumbnail');
    expect(res.statusCode).toBe(503);
    expect(res.headers).toMatchObject({ 'Retry-After': '7', 'Cache-Control': 'no-store' });
    expect(res.body).toMatchObject({ code });
  });

  test('every other error keeps its status and message', () => {
    for (const error of [new Error('boom'), refusal('IMAGE_RESOURCE_LIMIT'), refusal('ENOENT')]) {
      const res = response();
      errorResponse(res, error, 500, 'Failed to serve thumbnail');
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to serve thumbnail' });
      expect(res.headers['Retry-After']).toBeUndefined();
    }
  });
});

describe('resizeToBox', () => {
  const load = failure => {
    let processor;
    jest.isolateModules(() => {
      jest.doMock('../../src/services/isolatedSharp', () => Object.assign(
        jest.fn(() => ({ metadata: jest.fn().mockRejectedValue(failure) })), { cache: jest.fn(), concurrency: jest.fn() }));
      processor = require('../../src/services/imageProcessor');
    });
    jest.dontMock('../../src/services/isolatedSharp');
    return processor;
  };
  const input = Buffer.from('original bytes');
  const box = { width: 100, height: 100 };

  test('serves the original when the image is over the limits or cannot be decoded', async () => {
    for (const failure of [refusal('IMAGE_RESOURCE_LIMIT', { imageLimit: 'pixels' }), new Error('unsupported image format')]) {
      await expect(load(failure).resizeToBox(input, box)).resolves.toBe(input);
    }
  });

  test.each(['IMAGE_QUEUE_FULL', 'IMAGE_WORKER_UNAVAILABLE', 'IMAGE_TIMEOUT'])('passes %s to the route instead of serving the full size', async code => {
    await expect(load(refusal(code)).resizeToBox(input, box)).rejects.toMatchObject({ code });
  });
});

describe('validateUploadedFiles', () => {
  const run = async failure => {
    let validation;
    jest.isolateModules(() => {
      jest.doMock('../../src/services/isolatedSharp', () => Object.assign(
        jest.fn(() => ({ metadata: jest.fn().mockRejectedValue(failure) })), { metadataBatch: jest.fn() }));
      validation = require('../../src/middleware/uploadValidation');
    });
    jest.dontMock('../../src/services/isolatedSharp');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-validation-'));
    const file = { path: path.join(dir, 'photo.jpg'), originalname: 'photo.jpg' };
    fs.writeFileSync(file.path, 'bytes');
    const req = { files: [file] };
    try {
      await new Promise(resolve => validation.validateUploadedFiles(req, {}, resolve));
      return { req, kept: fs.existsSync(file.path) };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

  test('keeps a file the worker could not look at right now', async () => {
    const { req, kept } = await run(refusal('IMAGE_WORKER_UNAVAILABLE'));
    expect(kept).toBe(true);
    expect(req.files).toHaveLength(1);
    expect(req.invalidFiles || []).toEqual([]);
  });

  test('removes a file over the image limits and reports which limit', async () => {
    const { req, kept } = await run(refusal('IMAGE_RESOURCE_LIMIT', { imageLimit: 'pixels', imageMax: 268.4 }));
    expect(kept).toBe(false);
    expect(req.files).toEqual([]);
    expect(req.invalidFiles[0]).toMatchObject({ filename: 'photo.jpg', code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'pixels', imageMax: 268.4 });
  });
});
