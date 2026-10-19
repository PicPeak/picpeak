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
