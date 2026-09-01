import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Edit2, Trash2, Loader2, ArrowUp, ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { categoriesService, type PhotoCategory } from '../../services/categories.service';
import { Button } from '../common';
import { useMutationWithToast, useModal } from '../../hooks';

export const CategoryManager: React.FC = () => {
  const { t } = useTranslation();
  const addingModal = useModal();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingName, setEditingName] = useState('');

  // Fetch global categories (ordered by the global default display_order)
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['global-categories'],
    queryFn: categoriesService.getGlobalCategories,
  });

  // Local copy so the up/down reorder buttons feel instant; resynced when the
  // query data changes.
  const [ordered, setOrdered] = useState<PhotoCategory[]>(categories);
  useEffect(() => {
    setOrdered(categories);
  }, [categories]);

  // Set the GLOBAL default order (#782). Applies to every gallery that hasn't
  // set its own per-event override.
  const reorderMutation = useMutationWithToast({
    mutationFn: (orderedIds: number[]) => categoriesService.reorderGlobalCategories(orderedIds),
    invalidateKeys: [['global-categories']],
    errorMessage: t('categories.failedToReorder', 'Failed to update category order'),
  });

  const handleMove = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];
    setOrdered(next); // optimistic
    reorderMutation.mutate(next.map((c) => c.id));
  };

  // Create category mutation
  const createMutation = useMutationWithToast({
    mutationFn: (name: string) =>
      categoriesService.createCategory({ name, is_global: true }),
    invalidateKeys: [['global-categories']],
    successMessage: t('categories.categoryCreatedSuccess'),
    onSuccess: () => {
      setNewCategoryName('');
      addingModal.close();
    },
    errorMessage: t('categories.failedToCreateCategory'),
  });

  // Update category mutation
  const updateMutation = useMutationWithToast({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      categoriesService.updateCategory(id, name),
    invalidateKeys: [['global-categories']],
    successMessage: t('toast.categoryUpdated'),
    onSuccess: () => {
      setEditingId(null);
      setEditingName('');
    },
    errorMessage: t('toast.saveError'),
  });

  // Delete category mutation
  const deleteMutation = useMutationWithToast({
    mutationFn: categoriesService.deleteCategory,
    invalidateKeys: [['global-categories']],
    successMessage: t('categories.categoryDeletedSuccess'),
    errorMessage: t('categories.failedToDeleteCategory'),
  });

  const handleCreate = () => {
    if (newCategoryName.trim()) {
      createMutation.mutate(newCategoryName.trim());
    }
  };

  const handleUpdate = (id: number) => {
    if (editingName.trim()) {
      updateMutation.mutate({ id, name: editingName.trim() });
    }
  };

  const handleDelete = (category: PhotoCategory) => {
    if (window.confirm(t('categories.deleteConfirm', { name: category.name }))) {
      deleteMutation.mutate(category.id);
    }
  };

  const startEdit = (category: PhotoCategory) => {
    setEditingId(category.id);
    setEditingName(category.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('categories.title')}</h3>
        {!addingModal.isOpen && (
          <Button
            variant="primary"
            size="sm"
            onClick={addingModal.open}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            {t('categories.addCategory')}
          </Button>
        )}
      </div>

      {/* Add new category form */}
      {addingModal.isOpen && (
        <div className="flex gap-2 p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreate()}
            placeholder={t('categories.categoryName')}
            maxLength={100}
            className="flex-1 px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500"
            autoFocus
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreate}
            disabled={!newCategoryName.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              t('common.save')
            )}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              addingModal.close();
              setNewCategoryName('');
            }}
          >
            {t('common.cancel')}
          </Button>
        </div>
      )}

      {/* Categories list */}
      <div className="space-y-2">
        {ordered.length === 0 ? (
          <p className="text-neutral-500 dark:text-neutral-400 text-center py-8">
            {t('categories.noCategoriesYet')}
          </p>
        ) : (
          ordered.map((category, index) => (
            <div
              key={category.id}
              className="flex items-center justify-between p-3 bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors"
            >
              {editingId === category.id ? (
                <div className="flex gap-2 flex-1">
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') handleUpdate(category.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    maxLength={100}
                    className="flex-1 px-3 py-1 border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500"
                    autoFocus
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleUpdate(category.id)}
                    disabled={!editingName.trim() || updateMutation.isPending}
                  >
                    {updateMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      t('common.save')
                    )}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={cancelEdit}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Global default order (#782). The gallery uses this order
                        unless a specific event overrides it. */}
                    <div className="flex flex-col -space-y-1">
                      <button
                        onClick={() => handleMove(index, -1)}
                        disabled={index === 0 || reorderMutation.isPending}
                        className="p-0.5 text-neutral-400 dark:text-neutral-500 hover:text-accent-dark disabled:opacity-30 disabled:hover:text-neutral-400 transition-colors"
                        title={t('categories.moveUp', 'Move up')}
                        aria-label={t('categories.moveUp', 'Move up')}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleMove(index, 1)}
                        disabled={index === ordered.length - 1 || reorderMutation.isPending}
                        className="p-0.5 text-neutral-400 dark:text-neutral-500 hover:text-accent-dark disabled:opacity-30 disabled:hover:text-neutral-400 transition-colors"
                        title={t('categories.moveDown', 'Move down')}
                        aria-label={t('categories.moveDown', 'Move down')}
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-neutral-900 dark:text-neutral-100 truncate">{category.name}</p>
                      <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">/{category.slug}</p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => startEdit(category)}
                      className="p-1.5 text-neutral-600 dark:text-neutral-400 hover:text-accent dark:hover:text-accent hover:bg-accent-dark/15 rounded transition-colors"
                      title={t('common.edit')}
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(category)}
                      className="p-1.5 text-neutral-600 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
                      title={t('common.delete')}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

CategoryManager.displayName = 'CategoryManager';