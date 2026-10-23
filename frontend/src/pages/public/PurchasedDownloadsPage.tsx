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
  const { t } = useTranslation();
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
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <Loading size="lg" text={t('photoSales.loadingDownloads', 'Loading your downloads…')} />
      </div>
    );
  }

  if (state.status === 'expired') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900 px-4">
        <div className="max-w-md w-full bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-8 text-center">
          <AlertTriangle className="w-10 h-10 text-warning mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t('photoSales.accessExpired', 'Access expired')}
          </h1>
          <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
            {t('photoSales.accessExpiredHelp', 'Your access period for these photos has ended. Please contact your photographer if you need them again.')}
          </p>
        </div>
      </div>
    );
  }

  if (state.status === 'not-found') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900 px-4">
        <div className="max-w-md w-full bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-8 text-center">
          <AlertTriangle className="w-10 h-10 text-warning mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t('photoSales.linkNotFound', 'Download link not found')}
          </h1>
          <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
            {t('photoSales.linkNotFoundHelp', 'This link does not match any purchase. Please check the email you received or contact your photographer.')}
          </p>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900 px-4">
        <div className="max-w-md w-full bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-8 text-center">
          <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t('photoSales.loadError', 'Something went wrong')}
          </h1>
          <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{state.message}</p>
        </div>
      </div>
    );
  }

  const { data } = state;
  const expiresDate = data.expires_at
    ? new Date(data.expires_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-full bg-accent/15 flex items-center justify-center">
              <ShoppingBag className="w-6 h-6 text-accent" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
                {t('photoSales.yourDownloads', 'Your purchased photos')}
              </h1>
              {expiresDate && (
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {t('photoSales.accessUntil', 'Access valid until')} {expiresDate}
                </p>
              )}
            </div>
          </div>

          {data.photos.length === 0 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t('photoSales.noPhotos', 'No photos found for this purchase.')}
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
              {data.photos.map((photo) => (
                <li key={photo.id} className="py-3 flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200 break-all">
                    {photo.filename || `Photo ${photo.id}`}
                  </span>
                  {photo.photo_url ? (
                    <a
                      href={photo.photo_url}
                      className="inline-flex items-center gap-2 shrink-0 px-3 py-1.5 text-sm font-medium text-accent border border-accent rounded-lg hover:bg-accent/10 transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      {t('photoSales.download', 'Download')}
                    </a>
                  ) : (
                    <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
                      {t('photoSales.unavailable', 'Unavailable')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
