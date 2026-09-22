import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DOWNLOAD_QUOTA_CHANGED_EVENT,
  DOWNLOAD_LIMIT_SHOWN_EVENT,
  UNLIMITED_QUOTA,
  downloadCost,
  quotaAllows,
  quotaFromEvent,
  type DownloadQuota,
  type QuotaPhoto,
} from '../utils/downloadLimit';

// Download limit (issue 1560). Provided by GalleryView from the photos
// payload; anything rendered outside a limited gallery reads the unlimited
// default, so components can use it unconditionally.

export interface DownloadQuotaValue extends DownloadQuota {
  /** False only when the photo is new and nothing is left. */
  canDownload: (photo: QuotaPhoto) => boolean;
  /** Slots these photos use up; granted photos are free. */
  costOf: (photos: QuotaPhoto[]) => number;
  /** Whether these photos fit into what is left, as one download. */
  allows: (photos: QuotaPhoto[]) => boolean;
}

export function buildDownloadQuotaValue(quota: DownloadQuota): DownloadQuotaValue {
  return {
    ...quota,
    canDownload: (photo) => !quota.limited || !!photo.download_granted || (quota.remaining ?? 0) > 0,
    costOf: (photos) => (quota.limited ? downloadCost(photos) : 0),
    allows: (photos) => quotaAllows(quota, photos),
  };
}

const DownloadQuotaContext = createContext<DownloadQuotaValue>(buildDownloadQuotaValue(UNLIMITED_QUOTA));

interface DownloadQuotaProviderProps {
  slug: string;
  event?: Parameters<typeof quotaFromEvent>[0];
  children: React.ReactNode;
}

export const DownloadQuotaProvider: React.FC<DownloadQuotaProviderProps> = ({ slug, event, children }) => {
  const queryClient = useQueryClient();
  const quota = quotaFromEvent(event);
  const { limited, limit, used, remaining } = quota;

  // A download (or a refusal) changes what is left; re-read the payload so
  // the counter and the per-photo "already downloaded" state follow.
  useEffect(() => {
    if (!limited) return undefined;
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ slug?: string }>).detail?.slug !== slug) return;
      queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
    };
    // A refusal decided from the cached quota: it may be stale.
    const onShown = () => queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
    window.addEventListener(DOWNLOAD_QUOTA_CHANGED_EVENT, onChanged);
    window.addEventListener(DOWNLOAD_LIMIT_SHOWN_EVENT, onShown);
    return () => {
      window.removeEventListener(DOWNLOAD_QUOTA_CHANGED_EVENT, onChanged);
      window.removeEventListener(DOWNLOAD_LIMIT_SHOWN_EVENT, onShown);
    };
  }, [limited, slug, queryClient]);

  const value = useMemo(
    () => buildDownloadQuotaValue({ limited, limit, used, remaining }),
    [limited, limit, used, remaining]
  );
  return <DownloadQuotaContext.Provider value={value}>{children}</DownloadQuotaContext.Provider>;
};

export const useDownloadQuota = (): DownloadQuotaValue => useContext(DownloadQuotaContext);
