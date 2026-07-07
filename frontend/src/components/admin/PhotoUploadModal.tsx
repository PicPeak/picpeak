import React from 'react';
import { X } from 'lucide-react';
import { Button } from '../common';
import { PhotoUpload } from './PhotoUpload';
import { useTranslation } from 'react-i18next';

interface PhotoUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventId: number;
  onUploadComplete?: () => void;
}

export const PhotoUploadModal: React.FC<PhotoUploadModalProps> = ({
  isOpen,
  onClose,
  eventId,
  onUploadComplete
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  // Refresh the host's grid, but do NOT close here — closing is decided by
  // onUploadSettled so a partial-failure upload keeps the modal (and its
  // failure report) open.
  const handleUploadComplete = () => {
    onUploadComplete?.();
  };

  // Auto-close only on a clean upload; keep the modal open when some files
  // failed so the report stays visible until the user dismisses it.
  const handleUploadSettled = ({ hasFailures }: { hasFailures: boolean }) => {
    if (!hasFailures) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Fixed Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('upload.uploadMedia', t('events.uploadPhotos'))}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="!p-1"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <PhotoUpload
            eventId={eventId}
            onUploadComplete={handleUploadComplete}
            onUploadSettled={handleUploadSettled}
          />
        </div>
      </div>
    </div>
  );
};

PhotoUploadModal.displayName = 'PhotoUploadModal';
