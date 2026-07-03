import { api } from '../config/api';
import type { GalleryInfo, GalleryData, GalleryStats, ResolvedGalleryIdentifier } from '../types';
import { normalizeRequirePassword } from '../utils/accessControl';
import { parseContentDispositionFilename } from '../utils/contentDisposition';

// iOS is the only platform whose system share sheet exposes a
// first-party "Save Image" / "Save to Photos" action for files
// shared via navigator.share(). On Android the share sheet only
// lists installed apps that registered an image/* intent (WhatsApp,
// Telegram, etc.) — there is no built-in save-to-gallery action,
// so the share path produces a useless app-picker for users who
// just wanted to save the photo (#554). UA-sniff is the only signal
// available because feature detection (canShare) is true on both.
//
// The MacIntel + maxTouchPoints clause covers iPadOS 13+ which
// identifies as Mac in navigator.userAgent but supports the same
// share-to-Photos flow as iOS Safari.
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

// Hard cap on the multi-file Web Share path (#557). iOS Safari's share
// sheet starts to choke and silently fail beyond ~25–30 files in
// practice; equally important, every File materialises as an in-memory
// Blob before share() is invoked, so a 500-photo @ 10 MB selection
// would buffer 5 GB on the device. Above this cap we fall through to
// the existing server-side zip flow.
const MAX_WEB_SHARE_FILES = 25;

export const galleryService = {
  // Verify share token
  async verifyToken(slug: string, token: string): Promise<{ valid: boolean }> {
    const response = await api.get<{ valid: boolean }>(`/gallery/${slug}/verify-token/${token}`);
    return response.data;
  },

  // Get basic gallery info (no auth required)
  async getGalleryInfo(slug: string, token?: string): Promise<GalleryInfo> {
    const params = token ? { token } : {};
    const response = await api.get<GalleryInfo>(`/gallery/${slug}/info`, { params });
    const data = response.data;
    return {
      ...data,
      requires_password: normalizeRequirePassword((data as any)?.requires_password, true),
    };
  },

  // Get gallery photos (requires auth)
  async getGalleryPhotos(
    slug: string,
    filter?: 'liked' | 'favorited' | 'commented' | 'rated' | 'all',
    guestId?: string
  ): Promise<GalleryData> {
    const params: any = {};
    if (filter && filter !== 'all') {
      params.filter = filter;
      if (guestId) {
        params.guest_id = guestId;
      }
    }
    const response = await api.get<GalleryData>(`/gallery/${slug}/photos`, { params });
    const data = response.data;
    const normalizedEvent = data?.event
      ? {
          ...data.event,
          require_password: normalizeRequirePassword((data.event as any)?.require_password, true),
        }
      : data.event;
    return {
      ...data,
      event: normalizedEvent,
    };
  },

  // Save single photo. iOS routes through the Web Share API so the
  // share sheet's "Save Image" action lands the file in Photos.
  // Everywhere else (Android, desktop) navigates a hidden anchor
  // straight at the download URL — the browser's native download UI
  // shows up immediately and its progress lives in the notification
  // shade. Buffering the blob through fetch first (the original
  // path) added ~5s of dead air on cellular before any visible
  // feedback, prompting users to re-click and produce duplicate
  // downloads (#554 follow-up). Direct navigation eliminates the
  // latency outright rather than masking it with a spinner.
  async savePhotoToDevice(slug: string, photoId: number, filename: string): Promise<void> {
    if (!isIOS()) {
      this.triggerDirectDownload(
        api.getUri({ url: `/gallery/${slug}/download/${photoId}` }),
        filename,
      );
      return;
    }

    const fetched = await this.fetchPhotoBlob(slug, photoId);
    const resolvedFilename = fetched.serverFilename || filename;

    // canShare() returns false on browsers without Web Share file
    // support. Probe with a representative File so the negotiation
    // is accurate — `canShare({ files: [] })` returns true on some
    // browsers that don't actually accept files at share() time.
    const file = new File([fetched.blob], resolvedFilename, {
      type: fetched.blob.type || 'image/jpeg',
    });
    const canShareFile =
      typeof navigator !== 'undefined' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] });

    if (canShareFile) {
      try {
        await navigator.share({ files: [file], title: resolvedFilename });
        return;
      } catch (err) {
        // AbortError = user dismissed the share sheet. Don't fall back —
        // they made a choice. Any other failure (NotAllowedError,
        // DataError, etc.) is unexpected; surface a download instead so
        // the user still gets the file.
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }

    this.triggerBrowserDownload(fetched.blob, resolvedFilename);
  },

  // Fetch the photo as a Blob + the server-suggested filename, falling
  // back to the view endpoint when the original isn't available. Shared
  // between the regular download flow and the Web Share path (#531).
  // The server's Content-Disposition is the source of truth for the
  // filename (#493 — "use original camera filename" toggle reaches disk
  // through this header).
  async fetchPhotoBlob(
    slug: string,
    photoId: number,
  ): Promise<{ blob: Blob; serverFilename: string | null }> {
    const readResponse = (response: { data: Blob; headers: Record<string, string> }) => {
      const headerName =
        response.headers['content-disposition'] || response.headers['Content-Disposition'];
      return {
        blob: response.data,
        serverFilename: parseContentDispositionFilename(headerName),
      };
    };

    try {
      const response = await api.get(`/gallery/${slug}/download/${photoId}`, {
        responseType: 'blob',
      });
      return readResponse(response);
    } catch {
      // Fallback: view endpoint when /download isn't available (e.g.
      // the original is missing and only a derivative remains). The
      // view endpoint doesn't emit a download-oriented Content-Disposition,
      // so serverFilename will be null and the caller's name wins.
      const response = await api.get(`/gallery/${slug}/photo/${photoId}`, {
        responseType: 'blob',
      });
      return readResponse(response);
    }
  },

  // Trigger a regular browser download via a transient <a download>
  // anchor. Extracted from downloadPhoto so the share-fallback path
  // can reuse it without re-fetching the blob.
  triggerBrowserDownload(blob: Blob, filename: string): void {
    const url = window.URL.createObjectURL(new Blob([blob]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  // Trigger a browser-native download by navigating a hidden anchor at
  // the URL directly. The browser fetches the response itself (showing
  // its own progress UI), so unlike triggerBrowserDownload the JS layer
  // never materialises the bytes. `filename` is a hint; the server's
  // Content-Disposition wins per spec, which is what carries the #493
  // original-camera-filename setting through to disk.
  triggerDirectDownload(href: string, filename: string): void {
    const link = document.createElement('a');
    link.href = href;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
  },

  // Download single photo — kept as the canonical name for the existing
  // grid + lightbox-action callers that haven't been migrated to the
  // share-aware savePhotoToDevice path yet.
  async downloadPhoto(slug: string, photoId: number, filename: string): Promise<void> {
    const fetched = await this.fetchPhotoBlob(slug, photoId);
    this.triggerBrowserDownload(fetched.blob, fetched.serverFilename || filename);
  },

  // Download all photos as ZIP
  // When a pre-generated zip is available, use native browser download (Content-Length → progress bar).
  // Otherwise fall back to blob download.
  async downloadAllPhotos(slug: string, zipReady?: boolean): Promise<void> {
    if (zipReady) {
      // Native browser download — the server sends Content-Length so
      // the browser shows a real progress bar and mobile doesn't crash.
      const link = document.createElement('a');
      link.href = `/api/gallery/${slug}/download-all`;
      link.setAttribute('download', `${slug}.zip`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }

    // Fallback: blob download (no Content-Length, buffered in memory)
    const response = await api.get(`/gallery/${slug}/download-all`, {
      responseType: 'blob',
    });

    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${slug}.zip`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  // Download selected photos. On iOS with a small selection, route
  // through Web Share so the files land directly in Photos via the
  // share sheet's "Save N Images" action (#557, extending #531 to the
  // multi-photo case). Above the cap, or anywhere else, fall through
  // to the existing server-side zip flow.
  async downloadSelectedPhotos(slug: string, photoIds: number[]): Promise<void> {
    if (
      isIOS() &&
      photoIds.length > 0 &&
      photoIds.length <= MAX_WEB_SHARE_FILES
    ) {
      const status = await this.trySaveMultipleToDevice(slug, photoIds);
      // 'shared' = share() resolved; 'dismissed' = user closed the
      // share sheet — both terminate the flow without touching the
      // zip path. Only 'fallback' continues below.
      if (status !== 'fallback') return;
    }

    const response = await api.post(`/gallery/${slug}/download-selected`, { photo_ids: photoIds }, {
      responseType: 'blob',
    });

    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${slug}-selected.zip`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },

  // iOS-only Web Share path for a selection of photos.
  //
  // Returns:
  //   'shared'    — navigator.share resolved; files are now in the OS share sheet
  //   'dismissed' — user cancelled the share sheet (AbortError); do NOT fall back
  //   'fallback'  — capability missing or unexpected failure; caller should
  //                 use the server-side zip path instead
  //
  // Callers must gate by isIOS() + count <= MAX_WEB_SHARE_FILES before
  // invoking this; the method does not re-check those conditions.
  async trySaveMultipleToDevice(
    slug: string,
    photoIds: number[],
  ): Promise<'shared' | 'dismissed' | 'fallback'> {
    let fetched: Array<{ blob: Blob; serverFilename: string | null }>;
    try {
      // Parallel fetch — modern browsers cap at ~6 connections per origin
      // on HTTP/1.1, unlimited on HTTP/2, so 25 concurrent requests is
      // safe without an explicit semaphore. A single failed fetch
      // collapses the whole selection back to the zip path; partial
      // shares would leave the user wondering which photos were saved.
      fetched = await Promise.all(photoIds.map((id) => this.fetchPhotoBlob(slug, id)));
    } catch {
      return 'fallback';
    }

    const files = fetched.map((entry, idx) => {
      const name = entry.serverFilename || `photo-${photoIds[idx]}.jpg`;
      return new File([entry.blob], name, { type: entry.blob.type || 'image/jpeg' });
    });

    const canShareFiles =
      typeof navigator !== 'undefined' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files });

    if (!canShareFiles) return 'fallback';

    try {
      await navigator.share({ files });
      return 'shared';
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return 'dismissed';
      return 'fallback';
    }
  },

  // Toggle photo visibility (client-only)
  async togglePhotoVisibility(slug: string, photoId: number, visibility: 'visible' | 'hidden'): Promise<void> {
    await api.patch(`/gallery/${slug}/photos/${photoId}/visibility`, { visibility });
  },

  // Bulk toggle photo visibility (client-only)
  async bulkToggleVisibility(slug: string, photoIds: number[], visibility: 'visible' | 'hidden'): Promise<void> {
    await api.patch(`/gallery/${slug}/photos/visibility/bulk`, { photoIds, visibility });
  },

  // Get gallery statistics
  async getGalleryStats(slug: string): Promise<GalleryStats> {
    const response = await api.get<GalleryStats>(`/gallery/${slug}/stats`);
    return response.data;
  },

  async resolveIdentifier(identifier: string): Promise<ResolvedGalleryIdentifier> {
    const response = await api.get<ResolvedGalleryIdentifier>(`/gallery/resolve/${identifier}`);
    return response.data;
  },
};
