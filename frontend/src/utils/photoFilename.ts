import type { Photo } from '../types';

/** Guest-visible name: camera original when present, else stored filename. */
export function photoDisplayFilename(photo: Pick<Photo, 'filename' | 'original_filename'>): string {
  return photo.original_filename || photo.filename;
}

/**
 * Ascending name order by display filename. Numeric collation so camera names
 * without zero padding follow the shot sequence (IMG_9 < IMG_10 < IMG_100).
 */
export function photoNameCompare(
  a: Pick<Photo, 'filename' | 'original_filename'>,
  b: Pick<Photo, 'filename' | 'original_filename'>
): number {
  return photoDisplayFilename(a).localeCompare(photoDisplayFilename(b), undefined, { numeric: true });
}

export function photoMatchesFilenameSearch(
  photo: Pick<Photo, 'filename' | 'original_filename'>,
  term: string
): boolean {
  const needle = term.toLowerCase();
  return (
    photo.filename.toLowerCase().includes(needle) ||
    (photo.original_filename?.toLowerCase().includes(needle) ?? false)
  );
}
