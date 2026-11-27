import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useArchiveDownload } from '../../../contexts/ArchiveDownloadContext';
import { useDownloadQuota } from '../../../contexts/DownloadQuotaContext';
import { splitIntoArchives } from '../../../services/gallery.service';
import { analyticsService } from '../../../services/analytics.service';
import { isDownloadLimitError, showDownloadLimitReached } from '../../../utils/downloadLimit';
import type { DownloadResolutionChoice, Photo } from '../../../types';

interface DownloadAllOptions {
  photos: Photo[];
  slug: string;
  allowDownloads: boolean;
  onDownloadEverything?: () => void;
  downloadChoices?: DownloadResolutionChoice[];
  onPickResolution?: (photoIds: number[]) => void;
}

/**
 * The "Download All" of the full-page layouts, which have no gallery header
 * to offer it (issues 1160, 1710).
 */
export function useDownloadAll({
  photos,
  slug,
  allowDownloads,
  onDownloadEverything,
  downloadChoices,
  onPickResolution,
}: DownloadAllOptions) {
  const { t } = useTranslation();
  const archives = useArchiveDownload();
  const downloadQuota = useDownloadQuota();

  // The id fallback only runs when a category opts out of downloads (#640),
  // so it leaves those photos out, as the server would: a part made only of
  // them would come back empty and stop the parts after it.
  const downloadablePhotos = useMemo(
    () => photos.filter((photo) => photo.category_allow_downloads !== false),
    [photos]
  );

  const downloadAll = useCallback(async () => {
    // Whole-gallery path when available: posting ids would hit the server's
    // 500-id cap and silently truncate a large gallery (#1160).
    if (onDownloadEverything) {
      onDownloadEverything();
      return;
    }
    const ids = downloadablePhotos.map((p) => p.id);
    if (ids.length === 0) return;
    // Download limit (issue 1560): all or nothing, so refuse before asking.
    if (!downloadQuota.allows(downloadablePhotos)) {
      showDownloadLimitReached({ remaining: downloadQuota.remaining ?? 0 });
      return;
    }
    // One archive takes at most SELECTED_DOWNLOAD_LIMIT ids, so a larger set
    // goes as several zips rather than being cut short.
    const parts = splitIntoArchives(ids).length;
    // #858: hand off to the resolution picker when the gallery offers a choice.
    // The picker builds one archive, so past the cap it is skipped and the
    // parts come at the gallery's standard size.
    if (parts === 1 && downloadChoices && downloadChoices.length > 1 && onPickResolution) {
      onPickResolution(ids);
      return;
    }
    toast.info(parts > 1
      ? t('gallery.downloadingInParts', { count: ids.length, parts })
      : t('gallery.downloading', { count: ids.length }));
    try {
      if (!await archives.downloadPhotosInParts(slug, ids)) return;
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch (error) {
      if (!isDownloadLimitError(error)) toast.error(t('gallery.downloadError'));
    }
  }, [archives, downloadablePhotos, onDownloadEverything, slug, t, downloadChoices, onPickResolution, downloadQuota]);

  // Needs something to download: either the whole-gallery callback, or
  // downloadable photos in the current scope. On a folder-only root of a
  // gallery with a category download opt-out it has neither, and posting an
  // empty id list is a 400 (#1160).
  const canDownloadAll = allowDownloads && Boolean(onDownloadEverything || downloadablePhotos.length > 0);

  return { downloadAll, canDownloadAll };
}
