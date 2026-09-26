import React from 'react';
import { X } from 'lucide-react';
import { Button } from '../common';
import { PhotoUpload } from './PhotoUpload';
import { useTranslation } from 'react-i18next';

interface PhotoUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventId: number;
}

// The modal is only the picker. Once the files are handed to the upload
// session it closes; progress, the outcome and the failure report live in
// UploadProgressBar under the admin header, so the user is not held here
// while bytes move and the worker processes (discussion 1541).
export const PhotoUploadModal: React.FC<PhotoUploadModalProps> = ({
  isOpen,
  onClose,
  eventId,
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

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
          <PhotoUpload eventId={eventId} onUploadStarted={onClose} />
        </div>
      </div>
    </div>
  );
};

PhotoUploadModal.displayName = 'PhotoUploadModal';
