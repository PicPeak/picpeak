import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, AlertTriangle, ShoppingBag } from 'lucide-react';
import { api } from '../../config/api';
import { Loading } from '../../components/common';

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
}

type LoadState =
  | { status: 'loading' }
  | { status: 'expired' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PurchasedAccessPayload };

/**
 * Public purchased-downloads page (photo sales).
 *
 * The access token is bound to the order; the entitlement itself runs
 * against photo_purchases.expires_at server-side. This page is purely the
 * friendly face of /api/gallery/purchased-downloads/:accessToken.
 */
export const PurchasedDownloadsPage: React.FC = () => {
  const { accessToken } = useParams<{ accessToken: string }>();
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .get(`/gallery/purchased-downloads/${encodeURIComponent(accessToken || '')}`)
      .then((response) => {
        if (!cancelled) setState({ status: 'ready', data: response.data });
      })
      .catch((error) => {
        if (cancelled) return;
        if (error?.response?.status === 403) {
          setState({ status: 'expired' });
        } else if (error?.response?.status === 404) {
          setState({ status: 'not-found' });
        } else {
          setState({ status: 'error', message: error?.message || 'Failed to load downloads' });
        }
      });
    return () => { cancelled = true; };
  }, [accessToken]);

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
  const expiresDate = data.expires_at
    ? new Date(data.expires_at).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' })
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
                  {t('photoSales.yourDownloads', 'Your purchased photos')}
                </h1>
                <p className="mt-1 text-sm text-muted-theme">
                  {t('photoSales.photoCount', '{{count}} photos', { count: data.photos.length })}
                  {expiresDate && <> · {t('photoSales.accessUntil', 'Access valid until')} {expiresDate}</>}
                </p>
              </div>
            </div>
          </div>

          {data.photos.length === 0 ? (
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
        <p className="mt-4 text-center text-xs text-muted-theme">
          {t('photoSales.downloadHint', 'The files are the originals, without watermark. Keep them safe: this link stops working when your access ends.')}
        </p>
      </div>
    </div>
  );
};
