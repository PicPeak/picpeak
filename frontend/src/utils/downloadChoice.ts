import type { DownloadResolutionChoice } from '../types';

/**
 * Plain-language hints for the download menu (issue 1733, E2). A guest picks
 * between "Original" and an admin-named size like "Medium"; the hint says
 * what each is good for, judged on the size's long edge alone — the only
 * thing the payload knows about a resized download.
 */
export type DownloadChoiceKind = 'original' | 'print' | 'screen' | 'small';

// 2400 px prints at about 20 cm on the long side at 300 dpi; 1200 px still
// fills a phone or a laptop screen.
const PRINT_EDGE = 2400;
const SCREEN_EDGE = 1200;

export function downloadChoiceKind(choice: Pick<DownloadResolutionChoice, 'id' | 'width' | 'height'>): DownloadChoiceKind {
  if (choice.id === 'original' || !choice.width || !choice.height) return 'original';
  const longEdge = Math.max(choice.width, choice.height);
  if (longEdge >= PRINT_EDGE) return 'print';
  if (longEdge >= SCREEN_EDGE) return 'screen';
  return 'small';
}

// Formats the download route hands out at the uploaded size whatever was
// picked. Camera RAW, as backend/src/utils/rawFormats.js lists it (a test
// keeps the two in step), ships as stored (downloadRendition.shipsAsStored).
// HEIC/HEIF, and AVIF, which sharp reads as HEIF, come back from
// resizeToBox unresized because sharp cannot encode them.
const UPLOADED_SIZE_EXTENSIONS = new Set([
  'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'sr2', 'srf',
  'raf', 'rw2', 'orf', 'pef', 'srw', 'raw', '3fr', 'dcr', 'kdc',
  'heic', 'heif', 'avif',
]);

/** Whether the download route hands this photo out at its uploaded size, by its file name. */
export function downloadsAtUploadedSize(photo: { original_filename?: string | null; filename?: string | null }): boolean {
  const name = photo.original_filename || photo.filename || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && UPLOADED_SIZE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Sum of the stored file sizes, or null when any of them is unknown. */
export function knownTotalBytes(photos: ReadonlyArray<{ size?: number | null }>): number | null {
  if (photos.length === 0) return null;
  let total = 0;
  for (const photo of photos) {
    const size = Number(photo.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    total += size;
  }
  return total;
}
