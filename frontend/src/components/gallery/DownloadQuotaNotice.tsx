import React from 'react';
import { useTranslation } from 'react-i18next';
import { Download, AlertTriangle } from 'lucide-react';
import { useDownloadQuota } from '../../contexts/DownloadQuotaContext';
import { downloadPreviewOnlyMessage, type QuotaPhoto } from '../../utils/downloadLimit';

// Download limit (issue 1560) for the guest.
//
// Without `photos`: the gallery's counter, "3 of 10 downloads used".
// With `photos`: what downloading that selection costs, flagged before the
// click when it needs more than is left — the "11th photo" case.
// For a share-link guest of a limited gallery, who downloads preview-size
// copies and has no quota: that note instead of the counter.
// Renders nothing on an unlimited gallery.

interface DownloadQuotaNoticeProps {
  photos?: QuotaPhoto[];
  className?: string;
}

export const DownloadQuotaNotice: React.FC<DownloadQuotaNoticeProps> = ({ photos, className = '' }) => {
  const { t } = useTranslation();
  const quota = useDownloadQuota();
  if (quota.previewOnly && !photos) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 text-sm text-muted-theme ${className}`}
        role="status"
        data-testid="download-preview-only"
      >
        <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{downloadPreviewOnlyMessage()}</span>
      </div>
    );
  }
  if (!quota.limited) return null;

  const remaining = quota.remaining ?? 0;

  if (!photos) {
    const exhausted = remaining === 0;
    return (
      <div
        className={`inline-flex items-center gap-1.5 text-sm ${exhausted ? 'text-red-600' : 'text-muted-theme'} ${className}`}
        role="status"
        data-testid="download-quota-counter"
      >
        <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>
          {t('gallery.downloadLimit.counter', {
            used: quota.used,
            limit: quota.limit,
            defaultValue: '{{used}} of {{limit}} downloads used',
          })}
        </span>
      </div>
    );
  }

  const cost = quota.costOf(photos);
  const fits = cost <= remaining;
  return (
    <div
      className={`inline-flex items-center gap-1.5 text-sm ${fits ? 'text-muted-theme' : 'text-red-600 font-medium'} ${className}`}
      role={fits ? 'status' : 'alert'}
      data-testid="download-quota-selection"
    >
      {fits
        ? <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
        : <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />}
      <span>
        {fits
          ? t('gallery.downloadLimit.selectionCost', {
            cost,
            remaining,
            defaultValue: 'Uses {{cost}} of your {{remaining}} remaining downloads',
          })
          : t('gallery.downloadLimit.selectionTooLarge', {
            cost,
            remaining,
            defaultValue: 'Download limit: this selection needs {{cost}} downloads, only {{remaining}} left',
          })}
      </span>
    </div>
  );
};
