/**
 * The Recent feed's rows, shared by the dashboard's Recent box and the
 * activity page (/customer/activity).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import type { CustomerRecentItem } from '../../services/customer.service';

export function recentLabel(t: TFunction, item: CustomerRecentItem): string {
  const vars = { title: item.title };
  switch (item.kind) {
    case 'document_shared': return t('customer.dashboard.recent.documentShared', 'New document: {{title}}', vars);
    case 'document_uploaded': return t('customer.dashboard.recent.documentUploaded', 'You uploaded {{title}}', vars);
    case 'document_accepted': return t('customer.dashboard.recent.documentAccepted', '{{title}} was accepted', vars);
    case 'document_rejected': return t('customer.dashboard.recent.documentRejected', '{{title}} was not accepted', vars);
    case 'contract_sent': return t('customer.dashboard.recent.contractSent', 'Contract {{title}} was sent to you', vars);
    case 'contract_signed': return t('customer.dashboard.recent.contractSigned', 'You signed contract {{title}}', vars);
    case 'quote_sent': return t('customer.dashboard.recent.quoteSent', 'Quote {{title}} was sent to you', vars);
    case 'invoice_sent': return t('customer.dashboard.recent.invoiceSent', 'Invoice {{title}} was sent to you', vars);
    case 'gallery_assigned': return t('customer.dashboard.recent.galleryAssigned', 'Gallery {{title}} is now available to you', vars);
    case 'photos_added': {
      const photos = item.counts?.photos ?? 0;
      const videos = item.counts?.videos ?? 0;
      if (videos === 0) return t('customer.dashboard.recent.photosAdded', '{{count}} new photos in {{title}}', { ...vars, count: photos });
      if (photos === 0) return t('customer.dashboard.recent.videosAdded', '{{count}} new videos in {{title}}', { ...vars, count: videos });
      return t('customer.dashboard.recent.mediaAdded', '{{photos}} and {{videos}} in {{title}}', {
        ...vars,
        photos: t('customer.dashboard.recent.newPhotos', '{{count}} new photos', { count: photos }),
        videos: t('customer.dashboard.recent.videos', '{{count}} videos', { count: videos }),
      });
    }
    default: return item.title;
  }
}

export const RecentList: React.FC<{ items: CustomerRecentItem[] }> = ({ items }) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  return (
    <ul className="divide-y divide-border-token">
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <Link to={item.link} className="text-sm text-theme hover:underline min-w-0 break-words">
            {recentLabel(t, item)}
          </Link>
          <time dateTime={item.at} className="text-xs text-muted-theme whitespace-nowrap">{fmtDate(item.at)}</time>
        </li>
      ))}
    </ul>
  );
};
