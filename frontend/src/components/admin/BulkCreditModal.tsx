import React, { useEffect, useState } from 'react';
import { UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input } from '../common';

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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
              <UserRound className="w-5 h-5" aria-hidden="true" />
              {t('admin.photos.credit.bulkTitle', { count: photoCount })}
            </h2>
            <button
              onClick={handleClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              disabled={isLoading}
              aria-label={t('common.close')}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <Input
            label={t('admin.photos.credit.label')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            disabled={isLoading}
            helperText={t('admin.photos.credit.manualHint')}
          />

          <div className="mt-6 flex flex-wrap justify-end gap-2">
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
          </div>
        </div>
      </Card>
    </div>
  );
};

BulkCreditModal.displayName = 'BulkCreditModal';
