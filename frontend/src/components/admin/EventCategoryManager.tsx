import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Loader2, Image as ImageIcon, Check, Download, DownloadCloud } from 'lucide-react';
import { toast } from 'react-toastify';
import { categoriesService, type PhotoCategory } from '../../services/categories.service';
import { photosService } from '../../services/photos.service';
import { Button, Card, AuthenticatedImage } from '../common';
import { useTranslation } from 'react-i18next';

interface EventCategoryManagerProps {
  eventId: number;
}

export const EventCategoryManager: React.FC<EventCategoryManagerProps> = ({ eventId }) => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [isAdding, setIsAdding] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [heroPickerCategoryId, setHeroPickerCategoryId] = useState<number | null>(null);

  // Fetch categories for this event
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

  // Filter to show only event-specific categories
  const eventCategories = categories.filter(cat => !cat.is_global);

  // Create category mutation
  const createMutation = useMutation({
    mutationFn: (name: string) =>
      categoriesService.createCategory({
        name,
        is_global: false,
        event_id: eventId
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-categories', eventId] });
      toast.success(t('categories.categoryCreatedSuccess'));
      setNewCategoryName('');
      setIsAdding(false);
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('categories.failedToCreateCategory'));
    },
  });

  // Delete category mutation
  const deleteMutation = useMutation({
    mutationFn: categoriesService.deleteCategory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-categories', eventId] });
      toast.success(t('categories.categoryDeletedSuccess'));
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('categories.failedToDeleteCategory'));
    },
  });

  // Set hero photo mutation
  const heroMutation = useMutation({
    mutationFn: ({ categoryId, photoId }: { categoryId: number; photoId: number | null }) =>
      categoriesService.setCategoryHeroPhoto(categoryId, photoId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['event-categories', eventId] });
      setHeroPickerCategoryId(null);
      toast.success(variables.photoId ? t('categories.coverPhotoSet') : t('categories.coverPhotoRemoved'));
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('categories.failedToSetCoverPhoto'));
    },
  });

  // Toggle per-category download permission (#640). The backend AND's this
  // with the event-level `allow_downloads`, so disabling at either level
  // blocks downloads for this category's photos.
  const downloadToggleMutation = useMutation({
    mutationFn: ({ category, allow }: { category: PhotoCategory; allow: boolean }) =>
      categoriesService.updateCategory(category.id, category.name, { allow_downloads: allow }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['event-categories', eventId] });
      toast.success(
        variables.allow
          ? t('categories.downloadsEnabled', 'Downloads enabled for this category')
          : t('categories.downloadsDisabled', 'Downloads disabled for this category')
      );
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || t('categories.failedToToggleDownloads', 'Failed to update download permission'));
    },
  });

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

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('categories.eventSpecificCategories')}</h3>
        {!isAdding && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAdding(true)}
            leftIcon={<Plus className="w-3 h-3" />}
          >
            {t('common.add')}
          </Button>
        )}
      </div>

      {/* Hint about hero photo fallback */}
      <p className="text-xs text-neutral-500 dark:text-neutral-400 italic">
        {t('categories.categoryHeroHint')}
      </p>

      {/* Add new category form */}
      {isAdding && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreate()}
            placeholder={t('categories.categoryName')}
            className="flex-1 px-3 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500"
            autoFocus
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreate}
            disabled={!newCategoryName.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              t('common.add')
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setIsAdding(false);
              setNewCategoryName('');
            }}
          >
            {t('common.cancel')}
          </Button>
        </div>
      )}

      {/* Event categories list */}
      {eventCategories.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">
          {t('categories.noEventSpecificCategories')}
        </p>
      ) : (
        <div className="space-y-2">
          {eventCategories.map((category) => {
            const heroPhoto = category.hero_photo_id
              ? photos.find(p => p.id === category.hero_photo_id)
              : null;
            return (
              <div
                key={category.id}
                className="flex items-center justify-between px-3 py-2 bg-neutral-50 dark:bg-neutral-800 rounded-md"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
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
                </div>
                <div className="flex items-center gap-1">
                  {/* Per-category downloads toggle (#640). Green DownloadCloud
                      icon when on, struck-through outline when off. The
                      event-level `allow_downloads` AND's with this — if the
                      whole event has downloads off, this toggle is cosmetic. */}
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
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Show available global categories */}
      <div className="mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
        <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">{t('categories.globalCategoriesAlwaysAvailable')}</p>
        <div className="space-y-2">
          {categories
            .filter(cat => cat.is_global)
            .map(cat => {
              const heroPhoto = cat.hero_photo_id
                ? photos.find(p => p.id === cat.hero_photo_id)
                : null;
              return (
                <div key={cat.id} className="flex items-center gap-3 px-3 py-2 bg-neutral-50 dark:bg-neutral-800 rounded-md">
                  <button
                    onClick={() => setHeroPickerCategoryId(cat.id)}
                    className="flex-shrink-0 w-10 h-10 rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden bg-neutral-100 dark:bg-neutral-700 hover:border-accent-dark transition-colors flex items-center justify-center"
                    title={t('categories.setCoverPhoto')}
                  >
                    {heroPhoto ? (
                      <AuthenticatedImage
                        src={heroPhoto.thumbnail_url || heroPhoto.url}
                        alt={cat.name}
                        className="w-full h-full object-cover"
                      />
                    ) : cat.hero_photo_id ? (
                      <ImageIcon className="w-4 h-4 text-accent" />
                    ) : (
                      <ImageIcon className="w-4 h-4 text-neutral-300" />
                    )}
                  </button>
                  <span className="text-sm text-neutral-600 dark:text-neutral-400">{cat.name}</span>
                </div>
              );
            })}
        </div>
      </div>

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
                    const currentCategory = categories.find(c => c.id === heroPickerCategoryId);
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
                          <div className="absolute top-2 right-2 bg-accent-dark/150 text-white rounded-full p-1">
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
              {categories.find(c => c.id === heroPickerCategoryId)?.hero_photo_id && (
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
