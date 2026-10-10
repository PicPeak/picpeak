import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '../common';

interface CategoryOption {
  id: number;
  name: string;
  // Folders (#1160) have their own slot since issue 1786 (photos.folder_id)
  // and their own "Move to folder" action; they are not offered here.
  is_folder?: boolean;
}

interface BulkCategoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (categoryId: number | null) => Promise<void>;
  photoCount: number;
  categories: CategoryOption[];
  isLoading: boolean;
}

export const BulkCategoryModal: React.FC<BulkCategoryModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  photoCount,
  categories,
  isLoading,
}) => {
  const { t } = useTranslation();
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const filterCategories = categories.filter((category) => !category.is_folder);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    await onConfirm(selectedCategoryId);
  };

  const handleClose = () => {
    setSelectedCategoryId(null);
    onClose();
  };

  return (
    <Modal
      open
      onClose={() => { if (!isLoading) handleClose(); }}
      closeOnBackdrop={false}
      title={t('photos.moveToCategory', 'Move to Category', { count: photoCount })}
      size="sm"
      footer={
        <>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isLoading}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            isLoading={isLoading}
            leftIcon={<FolderOpen className="w-4 h-4" />}
          >
            {t('photos.movePhotos', 'Move Photos')}
          </Button>
        </>
      }
    >
      <label htmlFor="category-select" className="block text-sm font-medium text-body mb-2">
        {t('photos.selectCategory', 'Select category')}
      </label>
      <select
        id="category-select"
        value={selectedCategoryId ?? ''}
        onChange={(e) => setSelectedCategoryId(e.target.value === '' ? null : Number(e.target.value))}
        className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:ring-2 focus:ring-accent focus:border-accent-dark"
        disabled={isLoading}
      >
        <option value="">{t('photos.uncategorized', 'Uncategorized')}</option>
        {filterCategories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
    </Modal>
  );
};

BulkCategoryModal.displayName = 'BulkCategoryModal';
