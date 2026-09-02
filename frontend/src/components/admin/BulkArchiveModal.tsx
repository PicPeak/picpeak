import React from 'react';
import { Archive, AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../common';
import type { Event } from '../../types';

interface BulkArchiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  selectedEvents: Event[];
  isLoading?: boolean;
}

export const BulkArchiveModal: React.FC<BulkArchiveModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  selectedEvents,
  isLoading = false,
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  const count = selectedEvents.length;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('events.bulkArchive.title', 'Confirm Bulk Archive')}
            </h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              disabled={isLoading}
              aria-label={t('common.close', 'Close')}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <div className="mb-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-neutral-700">
                <p className="mb-2">
                  {t('events.bulkArchive.intro', 'You are about to archive {{count}} events. This action will:', { count })}
                </p>
                <ul className="list-disc list-inside space-y-1 text-neutral-600">
                  <li>{t('events.bulkArchive.effectZip', 'Create a ZIP archive of all photos for each event')}</li>
                  <li>{t('events.bulkArchive.effectInaccessible', 'Make the galleries inaccessible to guests')}</li>
                  <li>{t('events.bulkArchive.effectDelisted', 'Remove the events from active listings')}</li>
                  <li>{t('events.bulkArchive.effectStorage', 'Free up storage space by compressing photos')}</li>
                </ul>
              </div>
            </div>

            <div className="border border-neutral-200 rounded-lg max-h-48 overflow-y-auto">
              <div className="p-3">
                <h3 className="text-sm font-medium text-neutral-700 mb-2">
                  {t('events.bulkArchive.listHeading', 'Events to be archived:')}
                </h3>
                <ul className="space-y-1">
                  {selectedEvents.map((event) => (
                    <li key={event.id} className="text-sm text-neutral-600">
                      • {event.event_name} ({event.event_type})
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              isLoading={isLoading}
              leftIcon={<Archive className="w-4 h-4" />}
            >
              {t('events.bulkArchive.submit', 'Archive {{count}} events', { count })}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

BulkArchiveModal.displayName = 'BulkArchiveModal';