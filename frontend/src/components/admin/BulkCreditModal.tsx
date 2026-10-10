import React, { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal } from '../common';

interface BulkCreditModalProps {
  isOpen: boolean;
  onClose: () => void;
  // null clears the name.
  onConfirm: (creditName: string | null) => Promise<void>;
  photoCount: number;
  isLoading: boolean;
}

/**
 * Set or clear the credit on the selected photos (#1561) — the typo, the joke
 * name, or the guest who asked to be taken off their uploads.
 */
export const BulkCreditModal: React.FC<BulkCreditModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  photoCount,
  isLoading,
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  // The modal stays mounted while closed, so the last name would greet the
  // next selection. Cleared on every close — a confirm that succeeded
  // included; a refused one keeps the dialog open with the name to fix.
  useEffect(() => {
    if (!isOpen) setName('');
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClose = () => {
    setName('');
    onClose();
  };

  return (
    <Modal
      open={isOpen}
      onClose={() => { if (!isLoading) handleClose(); }}
      closeOnBackdrop={false}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <UserRound className="w-5 h-5" aria-hidden="true" />
          {t('admin.photos.credit.bulkTitle', { count: photoCount })}
        </span>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onConfirm(null)} disabled={isLoading}>
            {t('admin.photos.credit.clear')}
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(name.trim())}
            disabled={isLoading || !name.trim()}
            isLoading={isLoading}
          >
            {t('admin.photos.credit.save')}
          </Button>
        </>
      }
    >
      <Input
        label={t('admin.photos.credit.label')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        disabled={isLoading}
        helperText={t('admin.photos.credit.manualHint')}
      />
    </Modal>
  );
};

BulkCreditModal.displayName = 'BulkCreditModal';
