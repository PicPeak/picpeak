import type { Photo } from '../../types';

/**
 * The hero's image (issue 2429). The hero rendition is cut to 16:9 on the
 * server, so the whole photo comes from the uncropped preview the slideshow
 * uses; without one, the original.
 */
export function heroImageUrl(photo: Pick<Photo, 'hero_url' | 'slideshow_url' | 'url'>, whole: boolean): string {
  return whole ? photo.slideshow_url || photo.url : photo.hero_url || photo.url;
}
