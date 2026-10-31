import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { galleryService, splitIntoArchives } from '../services/gallery.service';
import { isGalleryLimited } from '../utils/downloadLimit';
import { DownloadResolutionModal } from '../components/gallery/DownloadResolutionModal';

export type StartedArchive = Awaited<ReturnType<typeof galleryService.startDownloadJob>>;
type Part = { index: number; total: number };
interface ArchiveDownloads {
  downloadAllPhotos: (slug: string, zipReady?: boolean) => Promise<boolean>;
  downloadSelectedPhotos: (slug: string, photoIds: number[], part?: Part, onProgress?: () => void) => Promise<boolean>;
  downloadPhotosInParts: (slug: string, photoIds: number[]) => Promise<boolean>;
}

const missingProvider = () => { throw new Error('Archive downloads require ArchiveDownloadProvider'); };
const ArchiveDownloadContext = createContext<ArchiveDownloads>({
  downloadAllPhotos: missingProvider,
  downloadSelectedPhotos: missingProvider,
  downloadPhotosInParts: missingProvider,
});

interface Request {
  slug: string;
  start: Promise<StartedArchive>;
  retry: () => void;
  part?: Part;
  onProgress?: () => void;
  photoIds?: number[];
}

const ArchiveDialogContext = createContext<{ dialog: React.ReactNode; cancel: () => void } | null>(null);
// The host stays below the live quota/rendition providers across layouts.
// Losing gallery access settles the action instead of hiding a pending promise.
export const ArchiveDownloadDialog: React.FC<{ available?: boolean }> = ({ available = true }) => {
  const controller = useContext(ArchiveDialogContext);
  const cancel = controller?.cancel;
  useEffect(() => { if (!available) cancel?.(); }, [available, cancel]);
  return available ? controller?.dialog ?? null : null;
};

/** UI owns preparation; the browser owns the ZIP transfer and its progress. */
export const ArchiveDownloadProvider: React.FC<{ children: React.ReactNode; scopeKey?: string; renderDialog?: boolean }> = ({ children, scopeKey, renderDialog = true }) => {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<((handedOff: boolean) => void) | null>(null);
  const sharing = useRef(false);
  const lifetime = useRef(0);
  const finish = useCallback((handedOff: boolean) => {
    pending.current?.(handedOff);
    pending.current = null;
    setRequest(null);
  }, []);
  const cancel = useCallback(() => { lifetime.current += 1; finish(false); }, [finish]);
  useEffect(() => {
    setRequest(null);
    return () => {
      lifetime.current += 1;
      pending.current?.(false);
      pending.current = null;
    };
  }, [scopeKey]);
  useEffect(() => {
    if (!request?.onProgress) return;
    // Existing selection busy guards must stay alive during a long build.
    const timer = window.setInterval(request.onProgress, 10_000);
    return () => window.clearInterval(timer);
  }, [request]);

  const prepare = useCallback((slug: string, photoIds?: number[], part?: Part, onProgress?: () => void): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.current = resolve;
      const start = () => {
        // Start in the action, not an effect: StrictMode must not POST twice.
        const promise = galleryService.startDownloadJob(slug, undefined, photoIds);
        // The modal consumes the rejection; attach immediately as it mounts.
        void promise.catch(() => {});
        setRequest({
          slug, start: promise, retry: start, onProgress,
          part, photoIds,
        });
      };
      start();
    });
  }, []);

  const downloadAllPhotos = useCallback(async (slug: string, zipReady?: boolean) => {
    if (pending.current || sharing.current) return false;
    if (zipReady && !isGalleryLimited(slug)) {
      galleryService.downloadCachedArchive(slug);
      return true;
    }
    return prepare(slug);
  }, [prepare]);
  const downloadSelectedPhotos = useCallback(async (slug: string, photoIds: number[], part?: Part, onProgress?: () => void) => {
    if (pending.current || sharing.current) return false;
    if (!part) {
      sharing.current = true;
      const run = lifetime.current;
      try {
        const share = await galleryService.trySaveSelectedToDevice(slug, photoIds);
        if (run !== lifetime.current) return false;
        if (share !== 'fallback') return share === 'shared';
      } finally { sharing.current = false; }
    }
    return prepare(slug, [...photoIds], part, onProgress);
  }, [prepare]);
  const downloadPhotosInParts = useCallback(async (slug: string, photoIds: number[]) => {
    const run = lifetime.current;
    const parts = splitIntoArchives(photoIds);
    if (parts.length <= 1) return downloadSelectedPhotos(slug, photoIds);
    for (let i = 0; i < parts.length; i += 1) {
      if (run !== lifetime.current) return false;
      if (!await downloadSelectedPhotos(slug, parts[i], { index: i + 1, total: parts.length })) return false;
    }
    return true;
  }, [downloadSelectedPhotos]);

  return <ArchiveDownloadContext.Provider value={{ downloadAllPhotos, downloadSelectedPhotos, downloadPhotosInParts }}>
    <ArchiveDialogContext.Provider value={{ cancel, dialog: request && <DownloadResolutionModal
      slug={request.slug} choices={[]} startedJob={request.start} onRetry={request.retry}
      photoIds={request.photoIds}
      part={request.part} onClose={() => finish(false)} onDownloaded={() => finish(true)}
    /> }}>
      {children}
      {renderDialog && <ArchiveDownloadDialog />}
    </ArchiveDialogContext.Provider>
  </ArchiveDownloadContext.Provider>;
};

export const useArchiveDownload = () => useContext(ArchiveDownloadContext);
