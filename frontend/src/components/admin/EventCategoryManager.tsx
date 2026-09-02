import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, X, Loader2, Image as ImageIcon, Check, Download, DownloadCloud, ArrowUp, ArrowDown, RotateCcw, Folder, FolderOpen } from 'lucide-react';
import { categoriesService, type PhotoCategory } from '../../services/categories.service';
import { photosService } from '../../services/photos.service';
import { Button, Card, AuthenticatedImage } from '../common';
import { useTranslation } from 'react-i18next';
import { useMutationWithToast, useModal } from '../../hooks';

interface EventCategoryManagerProps {
  eventId: number;
}

export const EventCategoryManager: React.FC<EventCategoryManagerProps> = ({ eventId }) => {
  const { t } = useTranslation();
  const addingModal = useModal();
  const [newCategoryName, setNewCategoryName] = useState('');
  const [heroPickerCategoryId, setHeroPickerCategoryId] = useState<number | null>(null);

  // Fetch this event's categories (globals + event-specific), already resolved
  // to the event's effective order by the backend (#782).
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['event-categories', eventId],
    queryFn: () => categoriesService.getEventCategories(eventId),
  });

  // Fetch photos for hero selection
  const { data: photos = [] } = useQuery({
    queryKey: ['admin-event-photos', eventId, {}],
    queryFn: () => photosService.getEventPhotos(eventId, {}),
    enabled: heroPickerCategoryId !== null,
  });

  // Combined list (globals + event-specific) in the resolved order, kept in
  // local state so the up/down reorder buttons feel instant; resynced whenever
  // the query data changes (e.g. after a reorder or reset persists).
  const [ordered, setOrdered] = useState<PhotoCategory[]>(categories);
  useEffect(() => {
    setOrdered(categories);
  }, [categories]);

  // The event is "customised" when it has its own per-event override.
  const isCustomised = ordered.some((c) => c.override_position != null);

  // Create category mutation (always event-specific)
  const createMutation = useMutationWithToast({
    mutationFn: (name: string) =>
      categoriesService.createCategory({ name, is_global: false, event_id: eventId }),
    invalidateKeys: [['event-categories', eventId]],
    successMessage: t('categories.categoryCreatedSuccess'),
    onSuccess: () => {
      setNewCategoryName('');
      addingModal.close();
    },
    errorMessage: t('categories.failedToCreateCategory'),
  });

  // Delete category mutation
  const deleteMutation = useMutationWithToast({
    mutationFn: categoriesService.deleteCategory,
    invalidateKeys: [['event-categories', eventId]],
    successMessage: t('categories.categoryDeletedSuccess'),
    errorMessage: t('categories.failedToDeleteCategory'),
  });

  // Set hero photo mutation
  const heroMutation = useMutationWithToast({
    mutationFn: ({ categoryId, photoId }: { categoryId: number; photoId: number | null }) =>
      categoriesService.setCategoryHeroPhoto(categoryId, photoId),
    invalidateKeys: [['event-categories', eventId]],
    successMessage: (_data, variables) =>
      variables.photoId ? t('categories.coverPhotoSet') : t('categories.coverPhotoRemoved'),
    onSuccess: () => {
      setHeroPickerCategoryId(null);
    },
    errorMessage: t('categories.failedToSetCoverPhoto'),
  });

  // Toggle per-category download permission (#640). Event-specific only.
  const downloadToggleMutation = useMutationWithToast({
    mutationFn: ({ category, allow }: { category: PhotoCategory; allow: boolean }) =>
      categoriesService.updateCategory(category.id, category.name, { allow_downloads: allow }),
    invalidateKeys: [['event-categories', eventId]],
    successMessage: (_data, variables) =>
      variables.allow
        ? t('categories.downloadsEnabled', 'Downloads enabled for this category')
        : t('categories.downloadsDisabled', 'Downloads disabled for this category'),
    errorMessage: t('categories.failedToToggleDownloads', 'Failed to update download permission'),
  });

  // Folder vs filter (#1160). Flipping this moves the category's photos out of
  // the root grid (or back into it) with no re-upload — it changes where they
  // render, never which photos exist or who can reach them.
  const folderToggleMutation = useMutationWithToast({
    mutationFn: ({ category, isFolder }: { category: PhotoCategory; isFolder: boolean }) =>
      categoriesService.updateCategory(category.id, category.name, { is_folder: isFolder }),
    // EventDetailsPage caches the same rows under a DIFFERENT key and feeds them
    // to the Photos tab's move dialog, so invalidating only this one left that
    // dialog labelling a fresh folder as a plain category (#1160).
    invalidateKeys: [['event-categories', eventId], ['admin-event-categories', String(eventId)]],
    successMessage: (_data, variables) =>
      variables.isFolder
        ? t('categories.folderEnabled', 'Photos in this category now sit inside a folder')
        : t('categories.folderDisabled', 'This category filters the gallery again'),
    errorMessage: t('categories.failedToToggleFolder', 'Failed to update folder setting'),
  });

  // Per-event order override (#782). Sends the full ordered id list; the backend
  // pins it for this gallery only. Up/down buttons match the invoice line-item
  // convention (no drag-and-drop dependency).
  const reorderMutation = useMutationWithToast({
    mutationFn: (orderedIds: number[]) => categoriesService.reorderCategories(eventId, orderedIds),
    invalidateKeys: [['event-categories', eventId]],
    errorMessage: t('categories.failedToReorder', 'Failed to update category order'),
  });

  // Revert this gallery to the global default order.
  const resetMutation = useMutationWithToast({
    mutationFn: () => categoriesService.resetEventOrder(eventId),
    invalidateKeys: [['event-categories', eventId]],
    successMessage: t('categories.orderReset', 'Reverted to the default order'),
    errorMessage: t('categories.failedToReorder', 'Failed to update category order'),
  });

  const handleMove = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];
    setOrdered(next); // optimistic — instant feedback
    reorderMutation.mutate(next.map((c) => c.id));
  };

  const handleCreate = () => {
    if (newCategoryName.trim()) {
      createMutation.mutate(newCategoryName.trim());
    }
  };

  const handleDelete = (category: PhotoCategory) => {
    if (window.confirm(t('categories.deleteConfirm', { name: category.name }))) {
      deleteMutation.mutate(category.id);
    }
  };

  const handleSelectHeroPhoto = (categoryId: number, photoId: number) => {
    heroMutation.mutate({ categoryId, photoId });
  };

  const handleRemoveHeroPhoto = (categoryId: number) => {
    heroMutation.mutate({ categoryId, photoId: null });
  };

  const busy = reorderMutation.isPending || resetMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-2">
        <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('categories.galleryOrder', 'Gallery order')}</h3>
        <div className="flex items-center gap-2">
          {isCustomised && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => resetMutation.mutate()}
              disabled={busy}
              leftIcon={<RotateCcw className="w-3 h-3" />}
            >
              {t('categories.resetToDefault', 'Reset to default')}
            </Button>
          )}
          {!addingModal.isOpen && (
            <Button
              variant="outline"
              size="sm"
              onClick={addingModal.open}
              leftIcon={<Plus className="w-3 h-3" />}
            >
              {t('common.add')}
            </Button>
          )}
        </div>
      </div>

      {/* Explain the two ordering layers */}
      <p className="text-xs text-neutral-500 dark:text-neutral-400 italic">
        {isCustomised
          ? t('categories.orderCustomisedHint', 'This gallery uses a custom order. Reset to follow the global default (Settings → Photo Categories).')
          : t('categories.orderDefaultHint', 'Use the arrows to set the order for this gallery. Otherwise it follows the global default (Settings → Photo Categories).')}
      </p>

      {/* Add new category form */}
      {addingModal.isOpen && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreate()}
            placeholder={t('categories.categoryName')}
            maxLength={100}
            className="flex-1 px-3 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500"
            autoFocus
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreate}
            disabled={!newCategoryName.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : t('common.add')}
          </Button>
          <Button
            variant="outline"
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

      {/* Combined, reorderable category list (globals + event-specific) */}
      {ordered.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">
          {t('categories.noEventSpecificCategories')}
        </p>
      ) : (
        <div className="space-y-2">
          {ordered.map((category, index) => {
            const heroPhoto = category.hero_photo_id
              ? photos.find(p => p.id === category.hero_photo_id)
              : null;
            return (
              <div
                key={category.id}
                className="flex items-center justify-between px-3 py-2 bg-neutral-50 dark:bg-neutral-800 rounded-md"
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {/* Reorder controls (#782). The gallery renders categories in
                      this order; changes here override the global default for
                      this event only. */}
                  <div className="flex flex-col -space-y-1">
                    <button
                      onClick={() => handleMove(index, -1)}
                      disabled={index === 0 || busy}
                      className="p-0.5 text-neutral-400 dark:text-neutral-500 hover:text-accent-dark disabled:opacity-30 disabled:hover:text-neutral-400 transition-colors"
                      title={t('categories.moveUp', 'Move up')}
                      aria-label={t('categories.moveUp', 'Move up')}
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleMove(index, 1)}
                      disabled={index === ordered.length - 1 || busy}
                      className="p-0.5 text-neutral-400 dark:text-neutral-500 hover:text-accent-dark disabled:opacity-30 disabled:hover:text-neutral-400 transition-colors"
                      title={t('categories.moveDown', 'Move down')}
                      aria-label={t('categories.moveDown', 'Move down')}
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {/* Hero photo thumbnail */}
                  <button
                    onClick={() => setHeroPickerCategoryId(category.id)}
                    className="flex-shrink-0 w-10 h-10 rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden bg-neutral-100 dark:bg-neutral-700 hover:border-accent-dark transition-colors flex items-center justify-center"
                    title={t('categories.setCoverPhoto')}
                  >
                    {heroPhoto ? (
                      <AuthenticatedImage
                        src={heroPhoto.thumbnail_url || heroPhoto.url}
                        alt={category.name}
                        className="w-full h-full object-cover"
                      />
                    ) : category.hero_photo_id ? (
                      <ImageIcon className="w-4 h-4 text-accent" />
                    ) : (
                      <ImageIcon className="w-4 h-4 text-neutral-300" />
                    )}
                  </button>
                  <span className="text-sm text-neutral-700 dark:text-neutral-300 truncate">{category.name}</span>
                  {category.is_global && (
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400">
                      {t('categories.sharedBadge', 'Shared')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {/* Download toggle + delete apply to event-specific categories
                      only. Global categories are managed in Settings. */}
                  {!category.is_global && (
                    <>
                      <button
                        onClick={() => folderToggleMutation.mutate({
                          category,
                          isFolder: !category.is_folder,
                        })}
                        className={`p-1 transition-colors ${
                          category.is_folder
                            ? 'text-primary-600 dark:text-primary-400 hover:text-neutral-400'
                            : 'text-neutral-400 dark:text-neutral-500 hover:text-primary-600 dark:hover:text-primary-400'
                        }`}
                        title={
                          category.is_folder
                            ? t('categories.disableFolderTitle', 'Folder: these photos are hidden from the main grid and shown only inside the folder. Click to make it a filter again.')
                            : t('categories.enableFolderTitle', 'Filter: these photos stay in the main grid. Click to turn it into a folder — hides them from the grid, does NOT restrict access.')
                        }
                        disabled={folderToggleMutation.isPending}
                      >
                        {folderToggleMutation.isPending ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : category.is_folder ? (
                          <FolderOpen className="w-3 h-3" />
                        ) : (
                          <Folder className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        onClick={() => downloadToggleMutation.mutate({
                          category,
                          allow: category.allow_downloads === false,
                        })}
                        className={`p-1 transition-colors ${
                          category.allow_downloads === false
                            ? 'text-neutral-400 dark:text-neutral-500 hover:text-green-600 dark:hover:text-green-400'
                            : 'text-green-600 dark:text-green-400 hover:text-neutral-400'
                        }`}
                        title={
                          category.allow_downloads === false
                            ? t('categories.enableDownloadsTitle', 'Click to enable downloads for this category')
                            : t('categories.disableDownloadsTitle', 'Click to disable downloads for this category')
                        }
                        disabled={downloadToggleMutation.isPending}
                      >
                        {downloadToggleMutation.isPending ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : category.allow_downloads === false ? (
                          <Download className="w-3 h-3" />
                        ) : (
                          <DownloadCloud className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        onClick={() => handleDelete(category)}
                        className="p-1 text-neutral-400 dark:text-neutral-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        title={t('categories.deleteCategoryTitle')}
                        disabled={deleteMutation.isPending}
                      >
                        {deleteMutation.isPending ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <X className="w-3 h-3" />
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Hint about hero photo fallback */}
      <p className="text-xs text-neutral-500 dark:text-neutral-400 italic">
        {t('categories.categoryHeroHint')}
      </p>

      {/* Hero Photo Picker Modal */}
      {heroPickerCategoryId !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <Card className="max-w-4xl w-full max-h-[90vh] overflow-hidden">
            <div className="p-6 border-b border-neutral-200 dark:border-neutral-700">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('categories.setCoverPhoto')}</h2>
                <button
                  onClick={() => setHeroPickerCategoryId(null)}
                  className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
              {photos.length === 0 ? (
                <p className="text-center text-neutral-500 dark:text-neutral-400 py-8">
                  {t('events.noPhotosAvailable')}
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {photos.map((photo) => {
                    const currentCategory = ordered.find(c => c.id === heroPickerCategoryId);
                    const isSelected = photo.id === currentCategory?.hero_photo_id;
                    return (
                      <div
                        key={photo.id}
                        onClick={() => handleSelectHeroPhoto(heroPickerCategoryId, photo.id)}
                        className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                          isSelected
                            ? 'border-accent-dark ring-2 ring-primary-500 ring-offset-2'
                            : 'border-transparent hover:border-neutral-300'
                        }`}
                      >
                        <div className="aspect-square bg-neutral-100 dark:bg-neutral-700">
                          <AuthenticatedImage
                            src={photo.thumbnail_url || photo.url}
                            alt={photo.filename}
                            className="w-full h-full object-cover"
                          />
                        </div>
                        {isSelected && (
                          <div className="absolute top-2 right-2 bg-accent-dark text-white rounded-full p-1">
                            <Check className="w-4 h-4" />
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                          <p className="text-white text-xs truncate">{photo.filename}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="p-6 border-t border-neutral-200 dark:border-neutral-700 flex justify-between gap-3">
              {ordered.find(c => c.id === heroPickerCategoryId)?.hero_photo_id && (
                <Button
                  variant="outline"
                  onClick={() => handleRemoveHeroPhoto(heroPickerCategoryId)}
                  disabled={heroMutation.isPending}
                >
                  {t('categories.removeCoverPhoto')}
                </Button>
              )}
              <div className="flex-1" />
              <Button
                variant="outline"
                onClick={() => setHeroPickerCategoryId(null)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

EventCategoryManager.displayName = 'EventCategoryManager';
