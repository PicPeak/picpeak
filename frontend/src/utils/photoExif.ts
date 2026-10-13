/**
 * Camera details of a photo (issue 1733, D1), as the lightbox and the admin
 * viewer print them: camera · lens · 50 mm · f/2.8 · 1/250 s · ISO 400.
 *
 * The server sends only these seven fields (backend services/photoExif.js),
 * and to guests only when the gallery shows them.
 */
import type { PhotoExif } from '../types';

const trimNumber = (value: number, decimals: number): string => String(Number(value.toFixed(decimals)));

/** Shutter speed as photographers write it: 1/250 s, 0.5 s, 2 s. */
export function formatExposureTime(seconds: number): string {
  if (seconds >= 0.3) return `${trimNumber(seconds, 1)} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

/** "Canon EOS R5", not "Canon Canon EOS R5"; "NIKON Z 6", not "NIKON CORPORATION NIKON Z 6". */
function cameraName(exif: PhotoExif): string | null {
  const make = exif.make?.trim();
  const model = exif.model?.trim();
  if (!make || !model) return model || make || null;
  const brand = make.split(' ')[0].toLowerCase();
  return model.toLowerCase().startsWith(brand) ? model : `${make} ${model}`;
}

/** The parts that exist, in display order. Empty when there is nothing to show. */
export function exifParts(exif: PhotoExif | null | undefined): string[] {
  if (!exif) return [];
  const parts: Array<string | null | undefined> = [
    cameraName(exif),
    exif.lens,
    exif.focal_length ? `${trimNumber(exif.focal_length, 1)} mm` : null,
    exif.aperture ? `f/${trimNumber(exif.aperture, exif.aperture < 1 ? 2 : 1)}` : null,
    exif.exposure_time ? formatExposureTime(exif.exposure_time) : null,
    exif.iso ? `ISO ${exif.iso}` : null,
  ];
  return parts.filter((part): part is string => !!part);
}

/** One line, or null when there is nothing to show. */
export function exifLine(exif: PhotoExif | null | undefined): string | null {
  const parts = exifParts(exif);
  return parts.length ? parts.join(' · ') : null;
}
