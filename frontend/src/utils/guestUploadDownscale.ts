/**
 * Optional downscale of a guest's photo before it is uploaded (issue 1733).
 *
 * A gallery may set a longest edge for guest uploads. JPEG, PNG and WebP
 * photos larger than that are scaled down in the browser and re-encoded in
 * the same format; everything else (HEIC, RAW, video, GIF, animations) is
 * sent as it is. Whenever the step fails, or does not make the file smaller,
 * the original goes out untouched.
 *
 * Re-encoding drops EXIF, so the capture date of a scaled JPEG is read first
 * and sent along as a form field.
 */

const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Enough for the EXIF block of a JPEG and the leading chunks of a PNG or WebP.
const HEAD_BYTES = 128 * 1024;
const JPEG_QUALITY = 0.9;

export interface PreparedGuestUpload {
  file: File;
  /** EXIF DateTimeOriginal of the original, "YYYY:MM:DD HH:MM:SS"; only set for a scaled JPEG. */
  capturedAt: string | null;
}

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

// FileReader rather than Blob.arrayBuffer(), which older Safari lacks.
const readHead = (file: File): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(file.slice(0, HEAD_BYTES));
});

/** A canvas would keep the first frame only. */
function isAnimated(head: Uint8Array, type: string): boolean {
  if (type === 'image/webp') {
    // RIFF <size> WEBP VP8X <size> <flags>: bit 1 of the flags is "animation".
    return head.length > 20 && ascii(head, 12, 4) === 'VP8X' && (head[20] & 0x02) !== 0;
  }
  if (type === 'image/png') {
    // An APNG announces itself with an acTL chunk ahead of the image data.
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let offset = 8;
    while (offset + 8 <= head.length) {
      const chunk = ascii(head, offset + 4, 4);
      if (chunk === 'acTL') return true;
      if (chunk === 'IDAT') return false;
      offset += 12 + view.getUint32(offset);
    }
  }
  return false;
}

/**
 * EXIF DateTimeOriginal from the leading bytes of a JPEG, as the raw EXIF
 * text. Bounded to the bytes given; null for anything it cannot follow.
 */
export function readExifCaptureDate(head: Uint8Array): string | null {
  try {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) return null;
      const marker = view.getUint8(offset + 1);
      // Start of scan / end of image: no metadata segment follows.
      if (marker === 0xda || marker === 0xd9) return null;
      const size = view.getUint16(offset + 2);
      if (size < 2) return null;
      // APP1 carrying "Exif\0\0" (XMP uses APP1 too, with another header).
      if (marker === 0xe1 && size >= 8 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
        return dateFromTiff(view, offset + 10, Math.min(offset + 2 + size, view.byteLength));
      }
      offset += 2 + size;
    }
    return null;
  } catch {
    // A read past the end of the bytes: truncated or malformed.
    return null;
  }
}

function dateFromTiff(view: DataView, start: number, end: number): string | null {
  const byteOrder = view.getUint16(start);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;
  const little = byteOrder === 0x4949;
  if (view.getUint16(start + 2, little) !== 42) return null;

  // Offset of a tag's 12-byte entry within one IFD, or null.
  const findEntry = (ifdOffset: number, tag: number): number | null => {
    const ifd = start + ifdOffset;
    if (ifdOffset < 8 || ifd + 2 > end) return null;
    const count = view.getUint16(ifd, little);
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      if (entry + 12 > end) return null;
      if (view.getUint16(entry, little) === tag) return entry;
    }
    return null;
  };

  // IFD0 → Exif sub-IFD (0x8769) → DateTimeOriginal (0x9003), an ASCII value
  // of 20 bytes stored at an offset.
  const exifPointer = findEntry(view.getUint32(start + 4, little), 0x8769);
  if (exifPointer === null) return null;
  const dateEntry = findEntry(view.getUint32(exifPointer + 8, little), 0x9003);
  if (dateEntry === null) return null;
  if (view.getUint16(dateEntry + 2, little) !== 2 || view.getUint32(dateEntry + 4, little) < 19) return null;
  const valueAt = start + view.getUint32(dateEntry + 8, little);
  if (valueAt + 19 > end) return null;
  let text = '';
  for (let index = 0; index < 19; index++) text += String.fromCharCode(view.getUint8(valueAt + index));
  return /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text : null;
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
    const head = await readHead(file);
    if (isAnimated(head, file.type)) return original;
    const blob = await downscale(file, maxEdge);
    // A browser that cannot encode the format answers with a PNG instead.
    if (!blob || blob.type !== file.type || blob.size >= file.size) return original;
    return {
      file: new File([blob], file.name, { type: file.type, lastModified: file.lastModified }),
      capturedAt: file.type === 'image/jpeg' ? readExifCaptureDate(head) : null,
    };
  } catch {
    return original;
  }
}
