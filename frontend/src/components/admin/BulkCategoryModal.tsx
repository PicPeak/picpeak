import React, { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../common';

interface CategoryOption {
  id: number;
  name: string;
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

  if (!isOpen) return null;

  const handleConfirm = async () => {
    await onConfirm(selectedCategoryId);
  };

  const handleClose = () => {
    setSelectedCategoryId(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('photos.moveToCategory', 'Move {{count}} photos to category', { count: photoCount })}
            </h2>
            <button
              onClick={handleClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              disabled={isLoading}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <div className="mb-6">
            <label htmlFor="category-select" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              {t('photos.selectCategory', 'Select category')}
            </label>
            <select
              id="category-select"
              value={selectedCategoryId ?? ''}
              onChange={(e) => setSelectedCategoryId(e.target.value === '' ? null : Number(e.target.value))}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              disabled={isLoading}
            >
              <option value="">{t('photos.uncategorized', 'Uncategorized')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-3">
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
          </div>
        </div>
      </Card>
    </div>
  );
};

BulkCategoryModal.displayName = 'BulkCategoryModal';
