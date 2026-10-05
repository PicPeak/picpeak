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
  photos: ReadonlyArray<FilenameListPhoto>,
  separator: FilenameListSeparator
): string {
  return [...photos]
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
    .map((photo) => photoFilenameStem(photoExportName(photo)))
    .join(separator === 'comma' ? ',' : ' ');
}

/** `source_filename` is on the payload once the backend ships it; optional here so either side can land first. */
type FilenameListPhoto = Pick<Photo, 'filename' | 'original_filename'> & { source_filename?: string | null };

/**
 * The name the admin export matches the master on (photoExportService
 * `cameraName`): `source_filename` is written once at ingest and survives a
 * replace, `original_filename` is overwritten by an edited render.
 */
function photoExportName(photo: FilenameListPhoto): string {
  return photo.source_filename || photoDisplayFilename(photo);
}

export type FilenameListSource = 'selection' | 'favorites';

/**
 * Whether a photo counts as one of the viewer's favourites for the filename
 * list. The standard layouts' "Favorited" filter reads `favorite` feedback —
 * the guest's own rows in identity mode, the aggregate count otherwise. The
 * premium and story layouts have no favourite control of that kind: their
 * Favourites toggle persists `like` feedback and seeds from the per-viewer
 * `is_liked`, so there a like is the favourite signal.
 */
export function isFilenameListFavourite(
  photo: Pick<Photo, 'id' | 'favorite_count' | 'is_liked'>,
  mode: {
    likeBacked: boolean;
    guestIdentity: boolean;
    myLiked: ReadonlySet<number>;
    myFavorited: ReadonlySet<number>;
    /**
     * False until the gallery's feedback settings have loaded successfully
     * (pending, or the error fallback that carries no identity_mode): the
     * identity mode is unknown then, and the aggregate fallback would offer
     * other guests' favourites in a guest-identity gallery.
     */
    settingsResolved?: boolean;
  }
): boolean {
  if (mode.settingsResolved === false) return false;
  if (mode.likeBacked) {
    return Boolean(photo.is_liked) || mode.myLiked.has(photo.id);
  }
  return mode.guestIdentity
    ? mode.myFavorited.has(photo.id)
    : (photo.favorite_count || 0) > 0;
}

/**
 * Which photos the guest's filename list covers: the selection, or the
 * viewer's favourites when nothing is selected. Cancelling selection mode
 * keeps the set (re-entering restores it), so it only counts while
 * `selectionActive`; a cancelled selection must not be copied as
 * "Selected photos" in place of the favourites.
 */
export function photosForFilenameList<P extends Pick<Photo, 'id'>>(
  photos: ReadonlyArray<P>,
  selectedIds: ReadonlySet<number>,
  isFavorited: (photo: P) => boolean,
  selectionActive = true
): { photos: P[]; source: FilenameListSource } {
  if (selectionActive && selectedIds.size > 0) {
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
