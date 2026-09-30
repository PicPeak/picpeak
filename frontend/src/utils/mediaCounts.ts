import type { TFunction } from 'i18next';

/**
 * Photos and videos share one table and one count. `photo_count` (and the
 * dashboard's `totalPhotos`) is the number of rows of either type;
 * `video_count` / `totalVideos` says how many of them are videos.
 */
export interface MediaSplit {
  photos: number;
  videos: number;
  hasVideos: boolean;
}

export function splitMediaCount(total?: number | string | null, videos?: number | string | null): MediaSplit {
  const all = Math.max(0, Number(total) || 0);
  const videoCount = Math.min(all, Math.max(0, Number(videos) || 0));
  return { photos: all - videoCount, videos: videoCount, hasVideos: videoCount > 0 };
}

/**
 * "137 photos · 6 videos", pluralised per locale. A side that is zero is left
 * out, so forty clips read "40 videos" and not "0 photos · 40 videos".
 */
export function mediaSplitLabel(t: TFunction, media: MediaSplit): string {
  const photos = t('events.photosCount', '{{count}} photos', { count: media.photos });
  const videos = t('events.videosCount', '{{count}} videos', { count: media.videos });
  if (media.videos === 0) return photos;
  if (media.photos === 0) return videos;
  return `${photos} · ${videos}`;
}

/** A runtime in seconds as m:ss, or h:mm:ss from one hour up. */
export function formatRuntime(totalSeconds?: number | string | null): string {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
