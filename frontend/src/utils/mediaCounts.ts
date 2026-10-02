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

/**
 * The test every grid uses to tell a video from a photo. The admin list
 * reports a photo as 'image' and the gallery as 'photo', and the file watcher
 * stores only the MIME type, so all three columns are consulted.
 */
export function isVideoItem(item: { media_type?: string | null; mime_type?: string | null; type?: string | null }): boolean {
  return item.media_type === 'video' || !!item.mime_type?.startsWith('video/') || item.type === 'video';
}

export function hasVideoItems(items: ReadonlyArray<{ media_type?: string | null; mime_type?: string | null; type?: string | null }>): boolean {
  return items.some(isVideoItem);
}

/**
 * "Select Photos" where everything on screen is a photo, "Select Media" once
 * a video is among them (issue 1430, item 3). The cancel label has no type.
 */
export function selectLabel(t: TFunction, hasVideos: boolean): string {
  return hasVideos
    ? t('gallery.selectMedia', 'Select Media')
    : t('gallery.selectPhotos', 'Select Photos');
}

/**
 * The admin grid's category badge for a row without a real category. The
 * server used to send the English "Individual Photos" / "Collages" for these,
 * which no locale could translate and which called a video a photo.
 */
export function defaultCategoryLabel(
  t: TFunction,
  item: { category_name?: string | null; category_slug?: string | null; media_type?: string | null; mime_type?: string | null; type?: string | null },
): string | null {
  if (item.category_name) return item.category_name;
  if (item.category_slug === 'individual') {
    return isVideoItem(item)
      ? t('admin.photos.individualVideos', 'Individual Videos')
      : t('admin.photos.individualPhotos', 'Individual Photos');
  }
  if (item.category_slug === 'collage') return t('admin.photos.collages', 'Collages');
  return null;
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
