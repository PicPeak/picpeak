import React from 'react';
import { Modal } from '../common';
import { PhotoUpload } from './PhotoUpload';
import { useTranslation } from 'react-i18next';

interface PhotoUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventId: number;
  /** Default of "Keep folder structure": the event's folder_structure (issue 1786). */
  folderStructureDefault?: boolean;
  /** Folder loose files go to at first; null = gallery root. */
  defaultFolderId?: number | null;
}

// The modal is only the picker. Once the files are handed to the upload
// session it closes; progress, the outcome and the failure report live in
// UploadProgressBar under the admin header, so the user is not held here
// while bytes move and the worker processes (discussion 1541).
export const PhotoUploadModal: React.FC<PhotoUploadModalProps> = ({
  isOpen,
  onClose,
  eventId,
  folderStructureDefault,
  defaultFolderId,
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      closeOnBackdrop={false}
      size="lg"
      title={t('upload.uploadMedia', t('events.uploadPhotos'))}
    >
      <PhotoUpload
        eventId={eventId}
        onUploadStarted={onClose}
        folderStructureDefault={folderStructureDefault}
        defaultFolderId={defaultFolderId}
      />
    </Modal>
  );
};

PhotoUploadModal.displayName = 'PhotoUploadModal';
