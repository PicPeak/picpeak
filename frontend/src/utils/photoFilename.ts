import type { Photo } from '../types';

/** Guest-visible name: camera original when present, else stored filename. */
export function photoDisplayFilename(photo: Pick<Photo, 'filename' | 'original_filename'>): string {
  return photo.original_filename || photo.filename;
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
