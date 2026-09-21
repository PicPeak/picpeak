import React from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Download, RotateCcw } from 'lucide-react';
import { eventsService } from '../../../services/events.service';
import { usePermission } from '../../../hooks/usePermission';

// Download limit usage on the event page (issue 1560): "7 / 10 downloaded",
// plus Reset, which clears the gallery's downloads so its whole quota is free
// again. Raising the limit goes through the ordinary edit form.

interface DownloadLimitUsageProps {
  eventId: number;
  downloadLimit: number;
}

export const DownloadLimitUsage: React.FC<DownloadLimitUsageProps> = ({ eventId, downloadLimit }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = usePermission('events.edit');

  const { data: usage } = useQuery({
    // The limit is part of the key so an edit re-reads the usage at once.
    queryKey: ['admin-event-download-limit', eventId, downloadLimit],
    queryFn: () => eventsService.getDownloadLimitUsage(eventId),
  });

  const resetMutation = useMutation({
    mutationFn: () => eventsService.resetDownloadLimitUsage(eventId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event-download-limit', eventId] });
      toast.success(t('events.downloadLimitResetDone', 'Downloads reset'));
    },
    onError: () => toast.error(t('events.downloadLimitResetFailed', 'Could not reset the downloads')),
  });

  const used = usage?.downloads_used ?? 0;
  const exhausted = used >= downloadLimit;

  const handleReset = () => {
    if (!window.confirm(t(
      'events.downloadLimitResetConfirm',
      'Reset the downloads for this gallery? The client gets the full limit again, and photos already downloaded count again.'
    ))) return;
    resetMutation.mutate();
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="download-limit-usage">
      <span
        className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded ${
          exhausted
            ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
            : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
        }`}
      >
        <Download className="w-3 h-3 mr-1" aria-hidden="true" />
        {t('events.downloadLimitUsage', '{{used}} / {{limit}} downloaded', { used, limit: downloadLimit })}
      </span>
      {canEdit && used > 0 && (
        <button
          type="button"
          onClick={handleReset}
          disabled={resetMutation.isPending}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-600 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          {t('events.downloadLimitReset', 'Reset')}
        </button>
      )}
    </div>
  );
};
