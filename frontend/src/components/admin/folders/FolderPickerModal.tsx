import React, { useState } from 'react';
import { FolderInput } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '../../common';
import type { FolderNode } from '../../../utils/folderTree';
import { FolderTreePicker } from './FolderTreePicker';

interface FolderPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (folderId: number | null) => void | Promise<void>;
  title: string;
  description?: string;
  confirmLabel: string;
  folders: FolderNode[];
  allowRoot?: boolean;
  isDisabled?: (id: number) => boolean;
  isLoading?: boolean;
  /** Preselected target; undefined = nothing picked yet. */
  initialValue?: number | null;
}

/** A folder tree picker in a dialog: move photos, move a folder, approve a request as… (issue 1786). */
export const FolderPickerModal: React.FC<FolderPickerModalProps> = (props) => {
  if (!props.isOpen) return null;
  // Mounted per opening, so the selection starts from initialValue each time.
  return <FolderPickerDialog {...props} />;
};

const FolderPickerDialog: React.FC<FolderPickerModalProps> = ({
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  folders,
  allowRoot = false,
  isDisabled,
  isLoading = false,
  initialValue,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<number | null | undefined>(initialValue);
  const picked = selected !== undefined && !(selected !== null && isDisabled?.(selected));

  return (
    <Modal
      open
      onClose={() => { if (!isLoading) onClose(); }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => picked && onConfirm(selected ?? null)}
            disabled={!picked}
            isLoading={isLoading}
            leftIcon={<FolderInput className="w-4 h-4" />}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <FolderTreePicker
        folders={folders}
        value={selected}
        onChange={setSelected}
        allowRoot={allowRoot}
        isDisabled={isDisabled}
      />
    </Modal>
  );
};
