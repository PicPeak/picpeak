import { useCallback } from 'react';
import { useQuery, useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { galleryService } from '../services';
import { toast } from 'react-toastify';
import { isDownloadLimitError } from '../utils/downloadLimit';
import { renamedGallerySlug } from './useFollowGalleryRename';
import { beginPhotoDownload, endPhotoDownload, touchPhotoDownload } from './usePhotoDownloadPending';

export const useGalleryInfo = (slug?: string, token?: string, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['gallery-info', slug, token],
    queryFn: () => {
      if (!slug) {
        throw new Error('Gallery slug is required');
      }
      return galleryService.getGalleryInfo(slug, token);
    },
    // A rename answer (301 naming the new slug) is final; retrying it only
    // delays the move to the new slug.
    retry: (failureCount, error) => !renamedGallerySlug(error) && failureCount < 1,
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: Boolean(slug) && enabled,
  });
};

export const useGalleryPhotos = (
  slug: string,
  filter?: 'liked' | 'favorited' | 'commented' | 'rated' | 'all',
  guestId?: string,
  enabled: boolean = true
) => {
  return useQuery({
    queryKey: ['gallery-photos', slug, filter, guestId],
    // Pass guestId so backend can filter per-guest views when needed
    queryFn: ({ signal }) => galleryService.getGalleryPhotos(slug, filter, guestId, signal),
    enabled,
    retry: 1,
    staleTime: 5 * 60 * 1000, // 5 minutes
    // Add a small delay to ensure auth token is properly set
    retryDelay: 100,
  });
};

export const useGalleryStats = (slug: string, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['gallery-stats', slug],
    queryFn: () => galleryService.getGalleryStats(slug),
    enabled,
    retry: 1,
    staleTime: 60 * 1000, // 1 minute
  });
};

// `resolution`: a size picked from the download menu (issue 1733, E2).
type PhotoDownload = { slug: string; photoId: number; filename: string; resolution?: string };

// Issue 2043: one download per photo at a time. `mutate` marks the photo
// busy before the request starts (so a second tap in the same moment is
// caught too) and answers false, starting nothing, while it already is.
const useSinglePhotoDownload = (
  download: (vars: PhotoDownload, onProgress: () => void) => Promise<void>,
  options: Omit<UseMutationOptions<void, Error, PhotoDownload & { token: number }>, 'mutationFn'>,
) => {
  const mutation = useMutation({
    ...options,
    mutationFn: ({ token, ...vars }: PhotoDownload & { token: number }) =>
      download(vars, () => touchPhotoDownload(vars.photoId, token))
        .finally(() => endPhotoDownload(vars.photoId, token)),
  });
  const { mutate } = mutation;
  const startDownload = useCallback((vars: PhotoDownload): boolean => {
    const token = beginPhotoDownload(vars.photoId);
    if (token === null) return false;
    mutate({ ...vars, token });
    return true;
  }, [mutate]);
  return { ...mutation, mutate: startDownload };
};

export const useDownloadPhoto = () => {
  return useSinglePhotoDownload(
    ({ slug, photoId, filename, resolution }, onProgress) => galleryService.downloadPhoto(slug, photoId, filename, onProgress, resolution),
    {
      onSuccess: () => {
        toast.success('Photo downloaded successfully');
      },
      onError: (error) => {
        // The limit refusal already said why (issue 1560).
        if (isDownloadLimitError(error)) return;
        toast.error('Failed to download photo');
      },
    },
  );
};

// Save-aware download — opens the OS share sheet on mobile (so "Save to
// Photos" lands the file in the Photos/Gallery app instead of Files),
// falls back to a regular download on browsers without Web Share file
// support. See galleryService.savePhotoToDevice for the negotiation
// (#531).
//
// Toast omitted on success because the share-sheet path doesn't really
// finish from this code's perspective — the OS UI takes over and the
// user picks where it goes. Showing "Photo downloaded" before they've
// even picked is misleading. The fallback download path is also silent
// to keep the two paths symmetrical; the file appearing in Downloads
// is its own affordance.
export const useSavePhotoToDevice = () => {
  return useSinglePhotoDownload(
    ({ slug, photoId, filename, resolution }, onProgress) => galleryService.savePhotoToDevice(slug, photoId, filename, onProgress, resolution),
    {
      onError: (error) => {
        if (isDownloadLimitError(error)) return;
        toast.error('Failed to save photo');
      },
    },
  );
};

export const useDownloadAllPhotos = () => {
  return useMutation({
    mutationFn: ({ slug, zipReady }: { slug: string; zipReady?: boolean }) =>
      galleryService.downloadAllPhotos(slug, zipReady),
    onSuccess: () => {
      toast.success('Download started');
    },
    onError: (error) => {
      if (isDownloadLimitError(error)) return;
      toast.error('Failed to download photos');
    },
  });
};
