import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, AlertTriangle, ShoppingBag, Clock } from 'lucide-react';
import { api } from '../../config/api';
import { Button, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

interface PurchasedPhoto {
  id: number;
  filename: string | null;
  photo_url: string | null;
}

interface PurchasedAccessPayload {
  order_id: string;
  gallery_slug: string | null;
  gallery_name?: string | null;
  buyer_email: string;
  expires_at: string | null;
  photos: PurchasedPhoto[];
  temporarily_disabled?: boolean;
  gallery_expires_at?: string | null;
  support_email?: string;
  photo_count?: number;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PurchasedAccessPayload };

async function loadAccess(accessToken: string, signal?: AbortSignal): Promise<LoadState> {
  try {
    const response = await api.get<PurchasedAccessPayload>(`/gallery/purchased-downloads/${encodeURIComponent(accessToken)}`, { signal });
    return { status: 'ready', data: response.data };
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 403) return { status: 'expired' };
    if (status === 404) return { status: 'not-found' };
    return { status: 'error', message: error instanceof Error ? error.message : 'Failed to load downloads' };
  }
}

/**
 * Public purchased-downloads page (photo sales).
 *
 * The access token is bound to the order; the entitlement itself runs
 * against photo_purchases.expires_at server-side. This page is purely the
 * friendly face of /api/gallery/purchased-downloads/:accessToken.
 */
export const PurchasedDownloadsPage: React.FC = () => {
  const { accessToken } = useParams<{ accessToken: string }>();
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const downloadPending = useRef(false);
  const downloadRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const request = new AbortController();
    setState({ status: 'loading' });
    loadAccess(accessToken || '', request.signal).then((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; request.abort(); downloadRequest.current?.abort(); };
  }, [accessToken, refreshKey]);

  const downloadPhoto = async (photoId: number) => {
    if (downloadPending.current) return;
    downloadPending.current = true;
    const request = new AbortController();
    downloadRequest.current = request;
    try {
      // A pause or refund may have happened since this page loaded. Refresh
      // the entitlement before handing a native download to the browser.
      const current = await loadAccess(accessToken || '', request.signal);
      if (request.signal.aborted) return;
      setState(current);
      if (current.status !== 'ready' || current.data.temporarily_disabled) return;
      const url = current.data.photos.find((photo) => photo.id === photoId)?.photo_url;
      if (!url) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally { downloadPending.current = false; }
  };

  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loading size="lg" text={t('photoSales.loadingDownloads', 'Loading your downloads…')} />
      </div>
    );
  }

  if (state.status !== 'ready') {
    const [title, help] = state.status === 'expired'
      ? [
        t('photoSales.accessExpired', 'Access expired'),
        t('photoSales.accessExpiredHelp', 'Your access period for these photos has ended. Please contact your photographer if you need them again.'),
      ]
      : state.status === 'not-found'
        ? [
          t('photoSales.linkNotFound', 'Download link not found'),
          t('photoSales.linkNotFoundHelp', 'This link does not match any purchase. Please check the email you received or contact your photographer.'),
        ]
        : [t('photoSales.loadError', 'Something went wrong'), state.message];
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md w-full bg-surface rounded-xl shadow-sm border border-surface p-8 text-center">
          <AlertTriangle className="w-10 h-10 text-warning mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-theme">{title}</h1>
          <p className="mt-3 text-sm text-muted-theme">{help}</p>
        </div>
      </div>
    );
  }

  const { data } = state;
  const paused = data.temporarily_disabled === true;
  const expiresDate = data.expires_at
    ? formatDateTime(data.expires_at)
    : null;

  return (
    <div className="min-h-screen bg-background py-10 sm:py-16 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-surface rounded-2xl shadow-sm border border-surface overflow-hidden">
          <div className="px-6 sm:px-8 pt-8 pb-6 border-b border-surface">
            <div className="flex items-start gap-4">
              <div className="photo-sales-promo-icon w-12 h-12 shrink-0 rounded-full flex items-center justify-center" aria-hidden="true">
                <ShoppingBag className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                {data.gallery_name && (
                  <p className="text-sm font-medium text-accent truncate">{data.gallery_name}</p>
                )}
                <h1 className="text-xl sm:text-2xl font-semibold text-theme">
                  {paused ? t('photoSales.purchaseConfirmed', 'Your purchase was successful') : t('photoSales.yourDownloads', 'Your purchased photos')}
                </h1>
                <p className="mt-1 text-sm text-muted-theme">
                  {t('photoSales.photoCount', '{{count}} photos', { count: data.photo_count ?? data.photos.length })}
                  {!paused && expiresDate && <> · {t('photoSales.accessUntil', 'Access valid until')} {expiresDate}</>}
                </p>
              </div>
            </div>
          </div>

          {paused ? (
            <div className="px-6 sm:px-8 py-6 text-sm text-muted-theme" role="status">
              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium text-theme">{t('gallery.temporarilyUnavailable', 'This gallery is temporarily unavailable.')}</p>
                  <p className="mt-2">{t('photoSales.purchasePausedHelp', 'Your purchase remains valid. Please use this same link when the gallery is available again. Time lost during the pause will be added to your download window, up to the gallery expiry date.')}</p>
                  {data.gallery_expires_at && <p className="mt-2">{t('photoSales.galleryExpiresOn', 'Gallery expiry: {{date}}', { date: formatDateTime(data.gallery_expires_at) })}</p>}
                  {data.support_email ? (
                    <p className="mt-3">
                      {t('photoSales.purchaseContact', 'For more information, contact:')}{' '}
                      <a className="text-accent underline break-all" href={`mailto:${data.support_email}`}>{data.support_email}</a>
                    </p>
                  ) : (
                    <p className="mt-3">{t('photoSales.purchaseContactPhotographer', 'Please contact your photographer for more information.')}</p>
                  )}
                  <Button variant="outline" className="mt-4" onClick={() => setRefreshKey((key) => key + 1)}>{t('gallery.tryAgain')}</Button>
                </div>
              </div>
            </div>
          ) : data.photos.length === 0 ? (
            <p className="px-6 sm:px-8 py-6 text-sm text-muted-theme">
              {t('photoSales.noPhotos', 'No photos found for this purchase.')}
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--color-surface-border)]">
              {data.photos.map((photo) => (
                <li key={photo.id} className="px-6 sm:px-8 py-3.5 flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-theme break-all">
                    {photo.filename || `Photo ${photo.id}`}
                  </span>
                  {photo.photo_url ? (
                    <a
                      href={photo.photo_url}
                      onClick={(event) => { event.preventDefault(); void downloadPhoto(photo.id); }}
                      aria-label={`${t('photoSales.download', 'Download')} ${photo.filename || ''}`.trim()}
                      className="inline-flex items-center gap-2 shrink-0 h-9 px-3.5 text-sm font-medium rounded-lg transition-opacity hover:opacity-90"
                      style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-accent-fg, #ffffff)' }}
                    >
                      <Download className="w-4 h-4" aria-hidden="true" />
                      <span className="hidden sm:inline">{t('photoSales.download', 'Download')}</span>
                    </a>
                  ) : (
                    <span className="text-xs text-muted-theme shrink-0">
                      {t('photoSales.unavailable', 'Unavailable')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {!paused && <p className="mt-4 text-center text-xs text-muted-theme">
          {t('photoSales.downloadHint', 'The files are the originals, without watermark. Keep them safe: this link stops working when your access ends.')}
        </p>}
      </div>
    </div>
  );
};
