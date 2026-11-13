/**
 * Website embed (issue 1112): /gallery/:slug/embed/:token, made to sit in an
 * <iframe> on another site. A photo grid of the gallery's visible stills, a
 * lightbox with the preview tier, and a link out to the full gallery. No
 * login, navigation, downloads, feedback or uploads.
 *
 * Images load through plain <img> tags: the embed only exists for a gallery
 * without a password, whose images the backend serves without a session, so
 * no cookie or token has to reach a third-party frame.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { embedService, type EmbedInfo, type EmbedPhoto } from '../../services/embed.service';
import { buildResourceUrl } from '../../utils/url';

type LoadState = 'loading' | 'ready' | 'unavailable';

export const EmbedGalleryPage: React.FC = () => {
  const { slug = '', token = '' } = useParams<{ slug: string; token: string }>();
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>('loading');
  const [info, setInfo] = useState<EmbedInfo | null>(null);
  const [photos, setPhotos] = useState<EmbedPhoto[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nextInfo, first] = await Promise.all([
          embedService.getInfo(slug, token),
          embedService.getPhotos(slug, token, 1),
        ]);
        if (cancelled) return;
        setInfo(nextInfo);
        setPhotos(first.photos);
        setHasMore(first.pagination.has_more);
        setState('ready');
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => { cancelled = true; };
  }, [slug, token]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await embedService.getPhotos(slug, token, page + 1);
      setPhotos((current) => [...current, ...next.photos]);
      setHasMore(next.pagination.has_more);
      setPage(page + 1);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const step = useCallback((delta: number) => {
    setOpen((current) => (current === null || photos.length === 0
      ? current
      : (current + delta + photos.length) % photos.length));
  }, [photos.length]);

  useEffect(() => {
    if (open === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step]);

  if (state === 'loading') {
    return <div className="min-h-screen bg-white dark:bg-neutral-950" aria-busy="true" />;
  }

  if (state === 'unavailable' || !info) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white text-neutral-600 dark:bg-neutral-950 dark:text-neutral-400 p-6 text-center">
        <p>{t('embed.unavailable', 'This gallery is not available.')}</p>
      </div>
    );
  }

  const galleryHref = buildResourceUrl(info.gallery_path) || info.gallery_path;
  const current = open !== null ? photos[open] : null;

  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 px-3 py-2">
        <h1 className="text-base font-medium truncate">{info.event.event_name}</h1>
        <a
          href={galleryHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm whitespace-nowrap text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          {t('embed.viewGallery', 'View full gallery')}
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      </header>

      {photos.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-neutral-500">{t('embed.empty', 'No photos yet.')}</p>
      ) : (
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1 px-1 list-none m-0">
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => setOpen(index)}
                className="block w-full aspect-square overflow-hidden bg-neutral-100 dark:bg-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                aria-label={t('embed.openPhoto', 'Open photo {{number}}', { number: index + 1 })}
              >
                <img
                  src={buildResourceUrl(photo.thumbnail_url)}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  className="w-full h-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="flex justify-center py-3">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="px-4 py-2 text-sm rounded-md border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
          >
            {t('embed.loadMore', 'Load more')}
          </button>
        </div>
      )}

      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={info.event.event_name}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={() => setOpen(null)}
        >
          <img
            src={buildResourceUrl(current.preview_url)}
            alt=""
            draggable={false}
            className="max-w-full max-h-full object-contain"
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="absolute top-2 right-2 p-2 text-white/80 hover:text-white"
            aria-label={t('embed.close', 'Close')}
          >
            <X className="w-6 h-6" />
          </button>
          {photos.length > 1 && (
            <>
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); step(-1); }}
                className="absolute left-1 top-1/2 -translate-y-1/2 p-2 text-white/80 hover:text-white"
                aria-label={t('embed.previous', 'Previous photo')}
              >
                <ChevronLeft className="w-8 h-8" />
              </button>
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); step(1); }}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-2 text-white/80 hover:text-white"
                aria-label={t('embed.next', 'Next photo')}
              >
                <ChevronRight className="w-8 h-8" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
