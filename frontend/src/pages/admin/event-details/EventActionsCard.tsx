import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Send, Copy } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';

interface EventActionsCardProps {
  event: Event;
  onArchive: () => void;
  isArchiving: boolean;
  setShowPublishDialog: (show: boolean) => void;
  isPublishing: boolean;
  setShowDuplicateDialog: (show: boolean) => void;
  isDuplicating: boolean;
}

export const EventActionsCard: React.FC<EventActionsCardProps> = ({
  event,
  onArchive,
  isArchiving,
  setShowPublishDialog,
  isPublishing,
  setShowDuplicateDialog,
  isDuplicating
}) => {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.actions')}</h2>

      <div className="space-y-3">
        {event.is_draft ? (
          <>
            <Button
              variant="primary"
              leftIcon={<Send className="w-4 h-4" />}
              onClick={() => setShowPublishDialog(true)}
              isLoading={isPublishing}
              className="w-full justify-center"
            >
              {t('events.publishAndNotify')}
            </Button>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
              {t('events.draftBanner')}
            </p>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              leftIcon={<Archive className="w-4 h-4" />}
              onClick={() => {
                if (confirm(t('events.archiveConfirm'))) {
                  onArchive();
                }
              }}
              isLoading={isArchiving}
              className="w-full justify-center"
            >
              {t('events.archiveEvent')}
            </Button>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
              {t('events.archivingInfo')}
            </p>
          </>
        )}
        {/* Duplicate (#626) — visible in both draft and live mode.
            Creates a new draft inheriting this gallery's config. */}
        <Button
          variant="outline"
          leftIcon={<Copy className="w-4 h-4" />}
          onClick={() => setShowDuplicateDialog(true)}
          isLoading={isDuplicating}
          className="w-full justify-center"
        >
          {t('events.duplicateEvent', 'Duplicate gallery')}
        </Button>
      </div>
    </Card>
  );
};
