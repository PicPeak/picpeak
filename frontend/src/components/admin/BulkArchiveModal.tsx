import React from 'react';
import { Archive, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '../common';
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
    <Modal
      open
      onClose={() => { if (!isLoading) onClose(); }}
      closeOnBackdrop={false}
      title={t('events.bulkArchive.title', 'Confirm Bulk Archive')}
      size="sm"
      footer={
        <>
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
        </>
      }
    >
      <div className="flex items-start gap-3 mb-4">
        <AlertTriangle className="w-5 h-5 text-warning-text flex-shrink-0 mt-0.5" />
        <div className="text-sm text-body">
          <p className="mb-2">
            {t('events.bulkArchive.intro', 'You are about to archive {{count}} events. This action will:', { count })}
          </p>
          <ul className="list-disc list-inside space-y-1 text-soft">
            <li>{t('events.bulkArchive.effectZip', 'Create a ZIP archive of all photos for each event')}</li>
            <li>{t('events.bulkArchive.effectInaccessible', 'Make the galleries inaccessible to guests')}</li>
            <li>{t('events.bulkArchive.effectDelisted', 'Remove the events from active listings')}</li>
            <li>{t('events.bulkArchive.effectStorage', 'Free up storage space by compressing photos')}</li>
          </ul>
        </div>
      </div>

      <div className="border border-line rounded-lg max-h-48 overflow-y-auto">
        <div className="p-3">
          <h3 className="text-sm font-medium text-body mb-2">
            {t('events.bulkArchive.listHeading', 'Events to be archived:')}
          </h3>
          <ul className="space-y-1">
            {selectedEvents.map((event) => (
              <li key={event.id} className="text-sm text-soft">
                • {event.event_name} ({event.event_type})
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
};

BulkArchiveModal.displayName = 'BulkArchiveModal';