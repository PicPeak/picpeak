/**
 * Optional downscale of guest uploads (issue 1733): which files are scaled,
 * that nothing is ever enlarged, that every failure sends the original, and
 * the bounded reader of the capture date the server would have taken.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPng, prepareGuestUpload, readExifCaptureDate } from '../guestUploadDownscale';

const DATE_TIME_ORIGINAL = 0x9003;
const CREATE_DATE = 0x9004;
const MODIFY_DATE = 0x0132;

/**
 * A TIFF block: IFD0 with ModifyDate (if given) and the Exif sub-IFD pointer,
 * the Exif IFD with the other dates given. Values are 20 ASCII bytes each.
 */
function tiffWithDates(dates: Record<number, string>, { little = true } = {}): Uint8Array {
  const exifTags = [DATE_TIME_ORIGINAL, CREATE_DATE].filter((tag) => dates[tag] !== undefined);
  const ifd0Tags = [MODIFY_DATE].filter((tag) => dates[tag] !== undefined);
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + (ifd0Tags.length + 1) * 12 + 4;
  let valueAt = exifAt + 2 + exifTags.length * 12 + 4;
  const tiff = new Uint8Array(valueAt + 20 * (exifTags.length + ifd0Tags.length));
  const view = new DataView(tiff.buffer);
  tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 42, little);
  view.setUint32(4, ifd0At, little);
  const writeDate = (entry: number, tag: number) => {
    view.setUint16(entry, tag, little);
    view.setUint16(entry + 2, 2, little);
    view.setUint32(entry + 4, 20, little);
    view.setUint32(entry + 8, valueAt, little);
    tiff.set(new TextEncoder().encode(dates[tag]), valueAt);
    valueAt += 20;
  };
  view.setUint16(ifd0At, ifd0Tags.length + 1, little);
  ifd0Tags.forEach((tag, index) => writeDate(ifd0At + 2 + index * 12, tag));
  const pointer = ifd0At + 2 + ifd0Tags.length * 12;
  view.setUint16(pointer, 0x8769, little);
  view.setUint16(pointer + 2, 4, little);
  view.setUint32(pointer + 4, 1, little);
  view.setUint32(pointer + 8, exifAt, little);
  view.setUint16(exifAt, exifTags.length, little);
  exifTags.forEach((tag, index) => writeDate(exifAt + 2 + index * 12, tag));
  return tiff;
}

/** A minimal JPEG head: SOI, an optional APP0, APP1/Exif, start of scan. */
function jpegWithDates(dates: Record<number, string>, { little = true, app0 = true } = {}): Uint8Array {
  const tiff = tiffWithDates(dates, { little });
  const app1Size = 2 + 6 + tiff.length;
  const bytes = [0xff, 0xd8];
  if (app0) bytes.push(0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46);
  bytes.push(0xff, 0xe1, app1Size >> 8, app1Size & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff);
  bytes.push(0xff, 0xda, 0x00, 0x02);
  return new Uint8Array(bytes);
}

const jpegWithExifDate = (date: string, options = {}) => jpegWithDates({ [DATE_TIME_ORIGINAL]: date }, options);

/** A PNG from its chunks; CRCs are left zero, nothing here checks them. */
function png(...chunks: Array<[string, Uint8Array | number]>): Uint8Array {
  const bodies = chunks.map(([, data]) => (typeof data === 'number' ? new Uint8Array(data) : data));
  const bytes = new Uint8Array(8 + bodies.reduce((total, body) => total + 12 + body.length, 0));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  chunks.forEach(([type], index) => {
    new DataView(bytes.buffer).setUint32(offset, bodies[index].length);
    bytes.set(new TextEncoder().encode(type), offset + 4);
    bytes.set(bodies[index], offset + 8);
    offset += 12 + bodies[index].length;
  });
  return bytes;
}

describe('readExifCaptureDate', () => {
  it('reads DateTimeOriginal in either byte order', () => {
    expect(readExifCaptureDate(jpegWithExifDate('2024:05:01 09:10:11'))).toBe('2024:05:01 09:10:11');
    expect(readExifCaptureDate(jpegWithExifDate('2023:12:31 23:59:59', { little: false, app0: false }))).toBe('2023:12:31 23:59:59');
  });

  it('falls back to CreateDate, then ModifyDate, as the server does', () => {
    expect(readExifCaptureDate(jpegWithDates({
      [DATE_TIME_ORIGINAL]: '2024:05:01 09:10:11', [CREATE_DATE]: '2023:05:01 09:10:11', [MODIFY_DATE]: '2022:05:01 09:10:11',
    }))).toBe('2024:05:01 09:10:11');
    expect(readExifCaptureDate(jpegWithDates({
      [CREATE_DATE]: '2023:05:01 09:10:11', [MODIFY_DATE]: '2022:05:01 09:10:11',
    }))).toBe('2023:05:01 09:10:11');
    expect(readExifCaptureDate(jpegWithDates({ [MODIFY_DATE]: '2022:05:01 09:10:11' }, { little: false })))
      .toBe('2022:05:01 09:10:11');
  });

  it('answers null for a JPEG that carries no date', () => {
    expect(readExifCaptureDate(jpegWithDates({}))).toBeNull();
    expect(readExifCaptureDate(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  // The server reads these more leniently than the form field allows (a
  // rolled-over month, another tag behind an unreadable one).
  it.each([
    'not a date at all!!', '2024-05-01T09:10:11', '2024:13:41 09:10:11', '2024:02:30 09:10:11', '    :  :     :  :  ',
  ])('cannot tell for the value %j', (value) => {
    expect(() => readExifCaptureDate(jpegWithDates({ [DATE_TIME_ORIGINAL]: value, [CREATE_DATE]: '2023:05:01 09:10:11' }))).toThrow();
  });

  it('cannot tell for a date longer than the plain shape, or an Exif pointer of another type', () => {
    const longer = jpegWithExifDate('2024:05:01 09:10:11Z');
    expect(() => readExifCaptureDate(longer)).toThrow();

    const pointerAsDouble = jpegWithExifDate('2024:05:01 09:10:11', { app0: false });
    // SOI(2) + APP1 header(4) + "Exif\0\0"(6) + TIFF header(8) + entry count(2), then the pointer entry's type.
    new DataView(pointerAsDouble.buffer).setUint16(22 + 2, 12, true);
    expect(() => readExifCaptureDate(pointerAsDouble)).toThrow();
  });

  it('cannot tell when an entry beside the date has no TIFF type', () => {
    const bytes = jpegWithDates({ [DATE_TIME_ORIGINAL]: '2024:05:01 09:10:11', [CREATE_DATE]: '2023:05:01 09:10:11' }, { app0: false });
    // TIFF at 12, IFD0 (one entry) at 20, Exif IFD at 38: its second entry is CreateDate.
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(38 + 2 + 12, true)).toBe(CREATE_DATE);
    view.setUint16(38 + 2 + 12 + 2, 14, true);
    expect(() => readExifCaptureDate(bytes)).toThrow();
  });

  it('cannot tell for another format or no bytes', () => {
    expect(() => readExifCaptureDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow();
    expect(() => readExifCaptureDate(new Uint8Array())).toThrow();
  });

  it('never answers "no date" for a head cut off ahead of the scan', () => {
    const full = jpegWithExifDate('2024:05:01 09:10:11');
    for (let length = 0; length < full.length; length++) {
      let result: string | null | undefined;
      try { result = readExifCaptureDate(full.slice(0, length)); } catch { result = undefined; }
      expect(result === undefined || result === '2024:05:01 09:10:11').toBe(true);
    }
    // EXIF behind more leading segments than the head holds.
    const padded = new Uint8Array(4 + 300);
    padded.set([0xff, 0xd8, 0xff, 0xec, 0xff, 0xff]);
    expect(() => readExifCaptureDate(padded)).toThrow();
  });
});

describe('inspectPng', () => {
  const exif = tiffWithDates({ [DATE_TIME_ORIGINAL]: '2024:05:01 09:10:11' });

  it('finds a static PNG without a date', () => {
    expect(inspectPng(png(['IHDR', 13], ['IDAT', 40], ['IEND', 0]))).toEqual({ animated: false, capturedAt: null });
  });

  it('reads the eXIf date ahead of or behind the image data', () => {
    expect(inspectPng(png(['IHDR', 13], ['eXIf', exif], ['IDAT', 40], ['IEND', 0])).capturedAt).toBe('2024:05:01 09:10:11');
    expect(inspectPng(png(['IHDR', 13], ['IDAT', 40], ['IDAT', 40], ['eXIf', exif], ['IEND', 0])).capturedAt).toBe('2024:05:01 09:10:11');
  });

  it('reads the chunk in another letter case and behind IEND, where the server finds it too', () => {
    expect(inspectPng(png(['IHDR', 13], ['exIf', exif], ['IDAT', 40], ['IEND', 0])).capturedAt).toBe('2024:05:01 09:10:11');
    expect(inspectPng(png(['IHDR', 13], ['IDAT', 40], ['IEND', 0], ['eXIf', exif])).capturedAt).toBe('2024:05:01 09:10:11');
  });

  it('sees acTL behind a chunk of any size', () => {
    expect(inspectPng(png(['IHDR', 13], ['iTXt', 200 * 1024], ['acTL', 8], ['IDAT', 40], ['IEND', 0])).animated).toBe(true);
  });

  it('cannot tell without image data, or with an unreadable eXIf', () => {
    expect(() => inspectPng(png(['IHDR', 13], ['iTXt', 64]))).toThrow();
    expect(() => inspectPng(png(['IHDR', 13], ['iTXt', 64]).slice(0, 40))).toThrow();
    expect(() => inspectPng(png(['IHDR', 13], ['eXIf', 16], ['IDAT', 40], ['IEND', 0]))).toThrow();
    expect(() => inspectPng(png(['IHDR', 13], ['IDAT', 40], ['eXIf', exif]).slice(0, -30))).toThrow();
  });
});

describe('prepareGuestUpload', () => {
  const close = vi.fn();
  const drawImage = vi.fn();
  let canvases: HTMLCanvasElement[];
  let bitmapSize: { width: number; height: number };
  let encoded: Blob | null;

  /** 5000 bytes of JPEG without a capture date. */
  const plainJpeg = () => {
    const bytes = new Uint8Array(5000);
    bytes.set([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    return bytes;
  };
  const photo = (type: string, name = 'photo.jpg', bytes: Uint8Array = plainJpeg()) =>
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

  const staticPng = (...extra: Array<[string, Uint8Array | number]>) =>
    png(['IHDR', 13], ...extra, ['IDAT', 5000], ['IEND', 0]);
  const staticWebp = () => {
    const bytes = new Uint8Array(5000);
    bytes.set(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '));
    return bytes;
  };

  it('re-encodes PNG and WebP in kind', async () => {
    for (const [type, bytes] of [['image/png', staticPng()], ['image/webp', staticWebp()]] as const) {
      encoded = new Blob([new Uint8Array(100)], { type });
      const result = await prepareGuestUpload(photo(type, 'a', bytes), 2048);
      expect(result.file.type).toBe(type);
      expect(result.file.size).toBe(100);
      expect(result.capturedAt).toBeNull();
    }
  });

  it('sends the date of a scaled PNG read from its eXIf chunk', async () => {
    encoded = new Blob([new Uint8Array(100)], { type: 'image/png' });
    const bytes = staticPng(['eXIf', tiffWithDates({ [CREATE_DATE]: '2023:05:01 09:10:11' })]);
    const result = await prepareGuestUpload(photo('image/png', 'a.png', bytes), 2048);
    expect(result.file.size).toBe(100);
    expect(result.capturedAt).toBe('2023:05:01 09:10:11');
  });

  it('sends the original when the capture date cannot be established', async () => {
    // A date the server would read from the file but the form field cannot carry.
    const odd = photo('image/jpeg', 'odd.jpg', (() => {
      const bytes = new Uint8Array(5000);
      bytes.set(jpegWithExifDate('2024:13:41 09:10:11'));
      return bytes;
    })());
    expect(await prepareGuestUpload(odd, 2048)).toEqual({ file: odd, capturedAt: null });
    // Metadata segments running past the bytes read.
    const long = new Uint8Array(200 * 1024);
    long.set([0xff, 0xd8]);
    for (let offset = 2; offset < long.length - 4; offset += 0xffff + 2) long.set([0xff, 0xec, 0xff, 0xff], offset);
    const deep = photo('image/jpeg', 'deep.jpg', long);
    expect(await prepareGuestUpload(deep, 2048)).toEqual({ file: deep, capturedAt: null });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('sends a PNG as it is when its animation cannot be established', async () => {
    const original = photo('image/png', 'a.png', png(['IHDR', 13], ['iTXt', 64]));
    expect(await prepareGuestUpload(original, 2048)).toEqual({ file: original, capturedAt: null });
    expect(createImageBitmap).not.toHaveBeenCalled();
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
    const original = photo('image/jpeg', 'small.jpg', plainJpeg().slice(0, 100));
    expect((await prepareGuestUpload(original, 2048)).file).toBe(original);
  });

  it('sends the original when the browser cannot encode the format', async () => {
    encoded = new Blob([new Uint8Array(100)], { type: 'image/png' });
    const original = photo('image/webp', 'a.webp', staticWebp());
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

    // acTL behind a text chunk larger than any leading slice of the file.
    const apng = photo('image/png', 'a.png', png(['IHDR', 13], ['iTXt', 200 * 1024], ['acTL', 8], ['IDAT', 5000], ['IEND', 0]));
    expect((await prepareGuestUpload(apng, 2048)).file).toBe(apng);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
