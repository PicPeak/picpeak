/**
 * Optional downscale of a guest's photo before it is uploaded (issue 1733).
 *
 * A gallery may set a longest edge for guest uploads. JPEG, PNG and WebP
 * photos larger than that are scaled down in the browser and re-encoded in
 * the same format; everything else (HEIC, RAW, video, GIF, animations) is
 * sent as it is. Whenever the step fails, or does not make the file smaller,
 * the original goes out untouched.
 *
 * Re-encoding drops EXIF, so the capture date the server would have read from
 * the original is read first and sent along as a form field. A file whose
 * date or animation cannot be established here is not scaled: the server can
 * still read the original, it cannot read what a canvas threw away.
 */

const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Enough for the EXIF block of a JPEG and the leading chunk of a WebP.
const HEAD_BYTES = 128 * 1024;
const JPEG_QUALITY = 0.9;

export interface PreparedGuestUpload {
  file: File;
  /** EXIF capture date of the original, "YYYY:MM:DD HH:MM:SS"; only set for a scaled photo. */
  capturedAt: string | null;
}

/** What a canvas re-encode would lose. */
interface Inspection {
  animated: boolean;
  capturedAt: string | null;
}

/** The bytes do not say what the server would read from this file. */
const undecidable = (): never => {
  throw new Error('undecidable');
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

// FileReader rather than Blob.arrayBuffer(), which older Safari lacks.
const readBytes = (blob: Blob): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

/**
 * Animation and capture date of a whole PNG. The whole file, because eXIf may
 * sit behind the image data (the server's reader takes it in any letter case,
 * and behind IEND too) and a large text chunk may sit ahead of acTL.
 * Throws when the chunks cannot be followed to the image data.
 */
export function inspectPng(bytes: Uint8Array): Inspection {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let capturedAt: string | null = null;
  let seenExif = false;
  let seenData = false;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const chunk = ascii(bytes, offset + 4, 4);
    // An APNG announces itself with an acTL chunk ahead of the image data; a
    // canvas would keep the first frame only.
    if (chunk === 'acTL' && !seenData) return { animated: true, capturedAt: null };
    if (chunk === 'IDAT') seenData = true;
    if (chunk.toLowerCase() === 'exif' && !seenExif) {
      seenExif = true;
      capturedAt = dateFromTiff(view, offset + 8, offset + 8 + length);
    }
    offset += 12 + length;
  }
  if (!seenData) return undecidable();
  return { animated: false, capturedAt };
}

/**
 * The EXIF capture date in the leading bytes of a JPEG, as the raw EXIF text;
 * null when the file carries none. Throws when it cannot tell: a date it
 * cannot read, or metadata running past the bytes given.
 */
export function readExifCaptureDate(head: Uint8Array): string | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint16(0) !== 0xffd8) return undecidable();
  let offset = 2;
  // A read past the end of the bytes throws, which is the answer wanted.
  for (;;) {
    if (view.getUint8(offset) !== 0xff) return undecidable();
    const marker = view.getUint8(offset + 1);
    // Fill bytes ahead of a marker.
    if (marker === 0xff) { offset += 1; continue; }
    // Start of scan / end of image: no metadata segment follows.
    if (marker === 0xda || marker === 0xd9) return null;
    const size = view.getUint16(offset + 2);
    if (size < 2) return undecidable();
    // APP1 carrying "Exif\0\0" (XMP uses APP1 too, with another header).
    if (marker === 0xe1 && size >= 8 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
      return dateFromTiff(view, offset + 10, offset + 2 + size);
    }
    offset += 2 + size;
  }
}

/** A real calendar date in the EXIF shape, the only kind the server takes from the form field. */
function isExifDate(text: string): boolean {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

/**
 * The date the server's extractCaptureDate takes from a TIFF block: the first
 * tag present of DateTimeOriginal, CreateDate and ModifyDate. Null with none
 * of them; throws when that tag does not hold a plain date, because the
 * server reads such values more leniently than the form field allows.
 */
function dateFromTiff(view: DataView, start: number, end: number): string | null {
  if (end > view.byteLength) return undecidable();
  const byteOrder = view.getUint16(start);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return undecidable();
  const little = byteOrder === 0x4949;
  if (view.getUint16(start + 2, little) !== 42) return undecidable();

  // Offset of a tag's 12-byte entry within one IFD, or null. An entry of a
  // type outside the TIFF ones makes the server's reader give up on the IFD.
  const findEntry = (ifdOffset: number, tag: number): number | null => {
    const ifd = start + ifdOffset;
    if (ifdOffset < 8 || ifd + 2 > end) return undecidable();
    const count = view.getUint16(ifd, little);
    if (ifd + 2 + count * 12 > end) return undecidable();
    let found: number | null = null;
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      const type = view.getUint16(entry + 2, little);
      if (type < 1 || type > 12) return undecidable();
      if (found === null && view.getUint16(entry, little) === tag) found = entry;
    }
    return found;
  };

  // IFD0 → Exif sub-IFD (0x8769) → DateTimeOriginal (0x9003), CreateDate
  // (0x9004); ModifyDate (0x0132) is in IFD0 itself.
  const ifd0 = view.getUint32(start + 4, little);
  const exifPointer = findEntry(ifd0, 0x8769);
  // The pointer is one LONG held in the entry itself.
  if (exifPointer !== null && (view.getUint16(exifPointer + 2, little) !== 4 || view.getUint32(exifPointer + 4, little) !== 1)) {
    return undecidable();
  }
  const exifIfd = exifPointer === null ? null : view.getUint32(exifPointer + 8, little);
  const dateEntry = (exifIfd === null ? null : findEntry(exifIfd, 0x9003) ?? findEntry(exifIfd, 0x9004))
    ?? findEntry(ifd0, 0x0132);
  if (dateEntry === null) return null;

  // An ASCII value stored at an offset: the 19 characters, with or without
  // the closing NUL. Anything longer is not the plain date read below.
  const count = view.getUint32(dateEntry + 4, little);
  if (view.getUint16(dateEntry + 2, little) !== 2 || (count !== 19 && count !== 20)) return undecidable();
  const valueAt = start + view.getUint32(dateEntry + 8, little);
  if (valueAt + count > end) return undecidable();
  if (count === 20 && view.getUint8(valueAt + 19) !== 0) return undecidable();
  let text = '';
  for (let index = 0; index < 19; index++) text += String.fromCharCode(view.getUint8(valueAt + index));
  return isExifDate(text) ? text : undecidable();
}

async function inspect(file: File): Promise<Inspection> {
  if (file.type === 'image/png') return inspectPng(await readBytes(file));
  const head = await readBytes(file.slice(0, HEAD_BYTES));
  if (file.type === 'image/webp') {
    // RIFF <size> WEBP VP8X <size> <flags>: bit 1 of the flags is "animation".
    // The server reads no capture date from a WebP.
    return { animated: head.length > 20 && ascii(head, 12, 4) === 'VP8X' && (head[20] & 0x02) !== 0, capturedAt: null };
  }
  return { animated: false, capturedAt: readExifCaptureDate(head) };
}

interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Older engines refuse the option or the format; an <img> may still decode it.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => { URL.revokeObjectURL(url); img.src = ''; },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** The scaled image, or null when it is already within the edge. Never upscales. */
async function downscale(file: File, maxEdge: number): Promise<Blob | null> {
  const source = await decode(file);
  const canvas = document.createElement('canvas');
  try {
    const longest = Math.max(source.width, source.height);
    if (!longest || longest <= maxEdge) return null;
    const scale = maxEdge / longest;
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, JPEG_QUALITY));
  } finally {
    // Phones keep decoded pixels until these are let go.
    source.release();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * The file to send for `file` under the gallery's longest edge (`maxEdge`,
 * empty for originals). Await one file at a time: each call holds a decoded
 * image in memory.
 */
export async function prepareGuestUpload(file: File, maxEdge: number | null | undefined): Promise<PreparedGuestUpload> {
  const original: PreparedGuestUpload = { file, capturedAt: null };
  if (!maxEdge || maxEdge <= 0 || !RESIZABLE_TYPES.has(file.type)) return original;
  try {
    // Throws, and so sends the original, when it cannot tell.
    const { animated, capturedAt } = await inspect(file);
    if (animated) return original;
    const blob = await downscale(file, maxEdge);
    // A browser that cannot encode the format answers with a PNG instead.
    if (!blob || blob.type !== file.type || blob.size >= file.size) return original;
    return {
      file: new File([blob], file.name, { type: file.type, lastModified: file.lastModified }),
      capturedAt,
    };
  } catch {
    return original;
  }
}
