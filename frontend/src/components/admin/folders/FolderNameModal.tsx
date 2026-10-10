import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '../../common';

interface FolderNameModalProps {
  isOpen: boolean;
  title: string;
  confirmLabel: string;
  initialName?: string;
  isLoading?: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

// photo_categories.name is varchar(100); the folder routes validate the same.
const MAX_NAME_LENGTH = 100;

/** Name a new folder or rename one (issue 1786). */
export const FolderNameModal: React.FC<FolderNameModalProps> = (props) => {
  if (!props.isOpen) return null;
  return <FolderNameDialog {...props} />;
};

const FolderNameDialog: React.FC<FolderNameModalProps> = ({
  title,
  confirmLabel,
  initialName = '',
  isLoading = false,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const submit = () => {
    if (trimmed && !isLoading) onConfirm(trimmed);
  };

  return (
    <Modal
      open
      onClose={() => { if (!isLoading) onClose(); }}
      title={title}
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!trimmed} isLoading={isLoading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <label htmlFor="folder-name" className="block text-sm font-medium text-body mb-2">
        {t('photos.folders.name', 'Folder name')}
      </label>
      <input
        ref={inputRef}
        id="folder-name"
        type="text"
        value={name}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:ring-2 focus:ring-accent"
      />
    </Modal>
  );
};
