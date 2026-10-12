/**
 * Optional downscale of guest uploads (issue 1733): which files are scaled,
 * that nothing is ever enlarged, that every failure sends the original, and
 * the bounded EXIF capture-date reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareGuestUpload, readExifCaptureDate } from '../guestUploadDownscale';

/** A minimal JPEG head: SOI, an optional APP0, then APP1/Exif with DateTimeOriginal. */
function jpegWithExifDate(date: string | null, { little = true, app0 = true } = {}): Uint8Array {
  const tiff = new Uint8Array(8 + 18 + 18 + 20);
  const view = new DataView(tiff.buffer);
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  // IFD0 at 8: one entry, the Exif sub-IFD pointer.
  view.setUint16(8, 1, little);
  view.setUint16(10, 0x8769, little);
  view.setUint16(12, 4, little);
  view.setUint32(14, 1, little);
  view.setUint32(18, 26, little);
  // Exif IFD at 26: one entry, DateTimeOriginal, 20 ASCII bytes at 44.
  view.setUint16(26, 1, little);
  view.setUint16(28, date === null ? 0x9004 : 0x9003, little);
  view.setUint16(30, 2, little);
  view.setUint32(32, 20, little);
  view.setUint32(36, 44, little);
  tiff.set(new TextEncoder().encode(date ?? '2024:05:01 09:10:11'), 44);

  const app1Size = 2 + 6 + tiff.length;
  const bytes = [0xff, 0xd8];
  if (app0) bytes.push(0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46);
  bytes.push(0xff, 0xe1, app1Size >> 8, app1Size & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff);
  bytes.push(0xff, 0xda, 0x00, 0x02);
  return new Uint8Array(bytes);
}

describe('readExifCaptureDate', () => {
  it('reads DateTimeOriginal in either byte order', () => {
    expect(readExifCaptureDate(jpegWithExifDate('2024:05:01 09:10:11'))).toBe('2024:05:01 09:10:11');
    expect(readExifCaptureDate(jpegWithExifDate('2023:12:31 23:59:59', { little: false, app0: false }))).toBe('2023:12:31 23:59:59');
  });

  it('answers null without the tag, without EXIF, or for another format', () => {
    expect(readExifCaptureDate(jpegWithExifDate(null))).toBeNull();
    expect(readExifCaptureDate(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
    expect(readExifCaptureDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(readExifCaptureDate(new Uint8Array())).toBeNull();
  });

  it('refuses a value that is not an EXIF date', () => {
    expect(readExifCaptureDate(jpegWithExifDate('not a date at all!!'))).toBeNull();
  });

  it('survives a head cut off anywhere', () => {
    const full = jpegWithExifDate('2024:05:01 09:10:11');
    for (let length = 0; length < full.length - 4; length++) {
      const result = readExifCaptureDate(full.slice(0, length));
      expect(result === null || result === '2024:05:01 09:10:11').toBe(true);
    }
  });
});

describe('prepareGuestUpload', () => {
  const close = vi.fn();
  const drawImage = vi.fn();
  let canvases: HTMLCanvasElement[];
  let bitmapSize: { width: number; height: number };
  let encoded: Blob | null;

  const photo = (type: string, name = 'photo.jpg', bytes: Uint8Array = new Uint8Array(5000)) =>
    new File([bytes], name, { type, lastModified: 1234 });

  beforeEach(() => {
    canvases = [];
    bitmapSize = { width: 6000, height: 4000 };
    encoded = new Blob([new Uint8Array(100)], { type: 'image/jpeg' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ ...bitmapSize, close })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return { drawImage } as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(encoded));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('scales a large JPEG to the longest edge, keeping name and type', async () => {
    const original = photo('image/jpeg', 'IMG_1.jpg', (() => {
      const bytes = new Uint8Array(5000);
      bytes.set(jpegWithExifDate('2024:05:01 09:10:11'));
      return bytes;
    })());
    const result = await prepareGuestUpload(original, 2048);

    expect(result.file).not.toBe(original);
    expect(result.file.name).toBe('IMG_1.jpg');
    expect(result.file.type).toBe('image/jpeg');
    expect(result.file.size).toBe(100);
    expect(result.capturedAt).toBe('2024:05:01 09:10:11');
    expect(createImageBitmap).toHaveBeenCalledWith(original, { imageOrientation: 'from-image' });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1365);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.9);
    // Decoded pixels are let go.
    expect(close).toHaveBeenCalledTimes(1);
    expect(canvases[0].width).toBe(0);
  });

  it('scales by the longest edge of a portrait photo', async () => {
    bitmapSize = { width: 3000, height: 4000 };
    await prepareGuestUpload(photo('image/jpeg'), 2000);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1500, 2000);
  });

  it('re-encodes PNG and WebP in kind, without a capture date', async () => {
    for (const type of ['image/png', 'image/webp']) {
      encoded = new Blob([new Uint8Array(100)], { type });
      const result = await prepareGuestUpload(photo(type, 'a'), 2048);
      expect(result.file.type).toBe(type);
      expect(result.file.size).toBe(100);
      expect(result.capturedAt).toBeNull();
    }
  });

  it.each([
    ['image/heic', 'a.heic'], ['image/heif', 'a.heif'], ['image/gif', 'a.gif'], ['video/mp4', 'a.mp4'],
    ['image/x-canon-cr2', 'a.cr2'], ['image/tiff', 'a.tif'], ['', 'a.nef'],
  ])('sends %s as it is, undecoded', async (type, name) => {
    const original = photo(type, name);
    expect(await prepareGuestUpload(original, 2048)).toEqual({ file: original, capturedAt: null });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0])('sends originals when the gallery sets no edge (%s)', async (maxEdge) => {
    const original = photo('image/jpeg');
    expect((await prepareGuestUpload(original, maxEdge)).file).toBe(original);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('never enlarges: a photo within the edge is sent as it is', async () => {
    for (const size of [{ width: 2048, height: 1365 }, { width: 800, height: 600 }]) {
      bitmapSize = size;
      const original = photo('image/jpeg');
      expect(await prepareGuestUpload(original, 2048)).toEqual({ file: original, capturedAt: null });
    }
    expect(drawImage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('sends the original when the result is not smaller', async () => {
    const original = photo('image/jpeg', 'small.jpg', new Uint8Array(100));
    expect((await prepareGuestUpload(original, 2048)).file).toBe(original);
  });

  it('sends the original when the browser cannot encode the format', async () => {
    encoded = new Blob([new Uint8Array(100)], { type: 'image/png' });
    const original = photo('image/webp', 'a.webp');
    expect((await prepareGuestUpload(original, 2048)).file).toBe(original);
    encoded = null;
    expect((await prepareGuestUpload(original, 2048)).file).toBe(original);
  });

  it('sends the original when decoding fails, bitmap and <img> alike', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode'); }));
    HTMLImageElement.prototype.decode = vi.fn(async () => { throw new Error('decode'); });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const original = photo('image/jpeg');
    expect(await prepareGuestUpload(original, 2048)).toEqual({ file: original, capturedAt: null });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });

  it('falls back to an <img> decode when createImageBitmap refuses', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new TypeError('option'); }));
    HTMLImageElement.prototype.decode = vi.fn(async () => {});
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(4000);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(2000);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const result = await prepareGuestUpload(photo('image/jpeg'), 1000);
    expect(result.file.size).toBe(100);
    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLImageElement), 0, 0, 1000, 500);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });

  it('sends the original when drawing throws', async () => {
    drawImage.mockImplementationOnce(() => { throw new Error('canvas too large'); });
    const original = photo('image/jpeg');
    expect((await prepareGuestUpload(original, 2048)).file).toBe(original);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves animations alone', async () => {
    const webp = new Uint8Array(5000);
    webp.set(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8X'));
    webp[20] = 0x02;
    const animatedWebp = photo('image/webp', 'a.webp', webp);
    expect((await prepareGuestUpload(animatedWebp, 2048)).file).toBe(animatedWebp);

    const png = new Uint8Array(5000);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    png.set(new TextEncoder().encode('IHDR'), 12);
    png.set([0, 0, 0, 8], 33);
    png.set(new TextEncoder().encode('acTL'), 37);
    const apng = photo('image/png', 'a.png', png);
    expect((await prepareGuestUpload(apng, 2048)).file).toBe(apng);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
