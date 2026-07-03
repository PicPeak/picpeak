import { Photo } from '../types';

interface PhotoUrlOptions {
  slug: string;
  photo: Photo;
  watermarkEnabled?: boolean;
  token?: string;
}

/**
 * Get the appropriate URL for a photo, using watermarked endpoint if enabled
 */
export function getPhotoUrl({ slug, photo, watermarkEnabled = false, token }: PhotoUrlOptions): string {
  if (watermarkEnabled && token) {
    // Use the watermarked photo endpoint (needs /api prefix)
    return `/api/gallery/${slug}/photo/${photo.id}`;
  }

  // Use the static photo URL
  return photo.url;
}

/**
 * Get the download URL for a photo
 */
export function getPhotoDownloadUrl(slug: string, photoId: number): string {
  return `/gallery/${slug}/download/${photoId}`;
}