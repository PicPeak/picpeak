import React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Download } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { archiveService } from '../../../services/archive.service';
import { safeParseDate } from './utils';

interface ArchiveStatusCardProps {
  event: Event;
  id: string | undefined;
}

export const ArchiveStatusCard: React.FC<ArchiveStatusCardProps> = ({ event, id }) => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.archiveStatusTitle')}</h2>

      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.archivedOn')}</p>
          <p className="text-sm text-neutral-900 dark:text-neutral-100">
            {event.archived_at && fmtDateTime(safeParseDate(event.archived_at)!)}
          </p>
        </div>

        {event.archive_path && (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Download className="w-4 h-4" />}
            onClick={async () => {
              try {
                toast.info(t('events.downloadingArchive', { name: event.event_name }));
                await archiveService.downloadArchive(Number(id), `${event.slug}-archive.zip`);
                toast.success(t('events.downloadStarted'));
              } catch {
                toast.error(t('events.failedToDownloadArchive'));
              }
            }}
            className="w-full justify-center"
          >
            {t('events.downloadArchive')}
          </Button>
        )}
      </div>
    </Card>
  );
};
