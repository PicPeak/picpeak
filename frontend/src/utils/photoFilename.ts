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

export type FilenameListSeparator = 'space' | 'comma';

/**
 * The name without its last extension, as the admin TXT export produces it
 * (photoExportService.exportAsTxt, `path.parse(name).name`): the gallery JPEG
 * may stand for a RAW file in the editor's catalog, so a search has to match
 * on the stem. A leading dot is part of the name, not an extension.
 */
export function photoFilenameStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * One line of stems for a RAW editor's filename search (issue 1733, A3d).
 * Same rules as the admin export: display filename, stem only, ordered by
 * the stored filename, comma joined without a space; the space variant is
 * for search fields that split on whitespace.
 */
export function joinFilenameStems(
  photos: ReadonlyArray<Pick<Photo, 'filename' | 'original_filename'>>,
  separator: FilenameListSeparator
): string {
  return [...photos]
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
    .map((photo) => photoFilenameStem(photoDisplayFilename(photo)))
    .join(separator === 'comma' ? ',' : ' ');
}

export type FilenameListSource = 'selection' | 'favorites';

/**
 * Which photos the guest's filename list covers: the selection, or the
 * viewer's favourites when nothing is selected.
 */
export function photosForFilenameList<P extends Pick<Photo, 'id'>>(
  photos: ReadonlyArray<P>,
  selectedIds: ReadonlySet<number>,
  isFavorited: (photo: P) => boolean
): { photos: P[]; source: FilenameListSource } {
  if (selectedIds.size > 0) {
    return { photos: photos.filter((photo) => selectedIds.has(photo.id)), source: 'selection' };
  }
  return { photos: photos.filter(isFavorited), source: 'favorites' };
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
