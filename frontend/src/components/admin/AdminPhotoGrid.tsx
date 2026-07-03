import React, { useState } from 'react';
import { Check, Download, Trash2, Eye, EyeOff, Heart, Package, MessageSquare, Star, Video, FolderOpen, Cog, AlertTriangle, RefreshCw, LayoutGrid, List } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { AdminPhoto } from '../../services/photos.service';
import { photosService } from '../../services/photos.service';
import { uploadsService } from '../../services/uploads.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { getPhotoViewMode, setPhotoViewMode, type PhotoViewMode } from '../../utils/photoViewPrefs';
import { Button } from '../common';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { BulkCategoryModal } from './BulkCategoryModal';

interface CategoryOption {
  id: number;
  name: string;
}

interface AdminPhotoGridProps {
  photos: AdminPhoto[];
  eventId: number;
  onPhotoClick: (photo: AdminPhoto, index: number) => void;
  onPhotosDeleted: () => void;
  onSelectionChange?: (selectedIds: number[]) => void;
  categories?: CategoryOption[];
}

export const AdminPhotoGrid: React.FC<AdminPhotoGridProps> = ({
  photos,
  eventId,
  onPhotoClick,
  onPhotosDeleted,
  onSelectionChange,
  categories = []
}) => {
  const { t } = useTranslation();
  const { format: formatDate } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletingPhotos, setDeletingPhotos] = useState<Set<number>>(new Set());
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [isUpdatingCategory, setIsUpdatingCategory] = useState(false);
  // Layout toggle (Grid / List) persisted per admin via localStorage.
  const [viewMode, setViewMode] = useState<PhotoViewMode>(() => getPhotoViewMode());

  // Persist on user action only — writing in an effect would re-save the
  // value on every mount (i.e. each time the Photos tab is opened), even
  // when the user never touched the toggle.
  const selectView = (mode: PhotoViewMode) => {
    setViewMode(mode);
    setPhotoViewMode(mode);
  };

  const handlePhotoSelect = (photoId: number, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    // Auto-enable selection mode when selecting via checkbox
    if (!isSelectionMode) {
      setIsSelectionMode(true);
    }
    const newSelected = new Set(selectedPhotos);
    if (newSelected.has(photoId)) {
      newSelected.delete(photoId);
    } else {
      newSelected.add(photoId);
    }
    setSelectedPhotos(newSelected);
    onSelectionChange?.(Array.from(newSelected));
  };

  const handleSelectAll = () => {
    let newSelected: Set<number>;
    if (selectedPhotos.size === photos.length) {
      newSelected = new Set();
    } else {
      newSelected = new Set(photos.map(p => p.id));
    }
    setSelectedPhotos(newSelected);
    onSelectionChange?.(Array.from(newSelected));
  };

  const handleDeleteSingle = async (photo: AdminPhoto, e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!confirm(`Are you sure you want to delete "${photo.filename}"?`)) {
      return;
    }

    setDeletingPhotos(prev => new Set(prev).add(photo.id));
    try {
      await photosService.deletePhoto(eventId, photo.id);
      toast.success('Photo deleted successfully');
      onPhotosDeleted();
    } catch {
      toast.error('Failed to delete photo');
      setDeletingPhotos(prev => {
        const newSet = new Set(prev);
        newSet.delete(photo.id);
        return newSet;
      });
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedPhotos.size === 0) return;

    const count = selectedPhotos.size;
    if (!confirm(`Are you sure you want to delete ${count} photo${count > 1 ? 's' : ''}?`)) {
      return;
    }

    setIsDeleting(true);
    const selectedIds = Array.from(selectedPhotos);
    setDeletingPhotos(new Set(selectedIds));
    
    try {
      await photosService.deletePhotos(eventId, selectedIds);
      toast.success(`${count} photo${count > 1 ? 's' : ''} deleted successfully`);
      setSelectedPhotos(new Set());
      setIsSelectionMode(false);
      onSelectionChange?.([]);
      onPhotosDeleted();
    } catch {
      toast.error('Failed to delete photos');
      setDeletingPhotos(new Set());
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDownload = async (photo: AdminPhoto, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await photosService.downloadPhoto(eventId, photo.id, photo.filename);
      toast.success('Download started');
    } catch {
      toast.error('Failed to download photo');
    }
  };

  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode);
    if (isSelectionMode) {
      setSelectedPhotos(new Set());
      onSelectionChange?.([]);
    }
  };

  const handleMoveToCategory = async (categoryId: number | null) => {
    if (selectedPhotos.size === 0) return;

    setIsUpdatingCategory(true);
    const selectedIds = Array.from(selectedPhotos);

    try {
      await photosService.updatePhotosCategory(eventId, selectedIds, categoryId);
      const categoryName = categoryId
        ? categories.find(c => Number(c.id) === categoryId)?.name || t('photos.selectedCategory', 'selected category')
        : t('photos.uncategorized', 'Uncategorized');
      toast.success(
        t('photos.movedToCategory', '{{count}} photos moved to {{category}}', {
          count: selectedIds.length,
          category: categoryName
        })
      );
      setSelectedPhotos(new Set());
      setIsSelectionMode(false);
      onSelectionChange?.([]);
      setIsCategoryModalOpen(false);
      onPhotosDeleted(); // Refresh the photo list
    } catch {
      toast.error(t('photos.moveToCategoryFailed', 'Failed to move photos to category'));
    } finally {
      setIsUpdatingCategory(false);
    }
  };

  return (
    <div>
      {/* Action Bar */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant={isSelectionMode ? "primary" : "outline"}
            size="sm"
            onClick={toggleSelectionMode}
            leftIcon={<Package className="w-4 h-4" />}
          >
            {isSelectionMode ? t('gallery.cancelSelection', 'Cancel Selection') : t('gallery.selectPhotos', 'Select Photos')}
          </Button>
          
          {(isSelectionMode || selectedPhotos.size > 0) && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSelectAll}
              >
                {selectedPhotos.size === photos.length ? t('gallery.deselectAll', 'Deselect All') : t('gallery.selectAll', 'Select All')}
              </Button>
              
              {selectedPhotos.size > 0 && (
                <>
                  <span className="text-sm text-neutral-600 dark:text-neutral-400">
                    {t('gallery.photosSelected', { count: selectedPhotos.size })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsCategoryModalOpen(true)}
                    leftIcon={<FolderOpen className="w-4 h-4" />}
                  >
                    {t('photos.moveToCategory', 'Move to Category')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await photosService.bulkUpdatePhotos(eventId, Array.from(selectedPhotos), { visibility: 'hidden' });
                        toast.success(t('admin.photos.hiddenSuccess', 'Photos hidden'));
                        onPhotosDeleted();
                      } catch { toast.error(t('common.error')); }
                    }}
                    leftIcon={<EyeOff className="w-4 h-4" />}
                  >
                    {t('admin.photos.hideSelected', 'Hide')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await photosService.bulkUpdatePhotos(eventId, Array.from(selectedPhotos), { visibility: 'visible' });
                        toast.success(t('admin.photos.visibleSuccess', 'Photos visible'));
                        onPhotosDeleted();
                      } catch { toast.error(t('common.error')); }
                    }}
                    leftIcon={<Eye className="w-4 h-4" />}
                  >
                    {t('admin.photos.showSelected', 'Show')}
                  </Button>
                  <button
                    onClick={handleDeleteSelected}
                    disabled={isDeleting}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-lg flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    {t('gallery.deleteSelected', 'Delete Selected')}
                  </button>
                </>
              )}
            </>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          <div className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('gallery.photosCount', { count: photos.length })}
          </div>
          {/* Layout toggle: Grid / List — radiogroup so a screen reader
              announces the two options as one mutually-exclusive set. */}
          <div className="inline-flex rounded-lg border border-neutral-300 dark:border-neutral-600 overflow-hidden" role="radiogroup" aria-label={t('admin.photos.viewMode', 'View mode')}>
            <button
              type="button"
              role="radio"
              onClick={() => selectView('grid')}
              aria-checked={viewMode === 'grid'}
              title={t('admin.photos.gridView', 'Grid view')}
              className={`p-1.5 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-primary-500 text-white'
                  : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              type="button"
              role="radio"
              onClick={() => selectView('list')}
              aria-checked={viewMode === 'list'}
              title={t('admin.photos.listView', 'List view')}
              className={`p-1.5 transition-colors border-l border-neutral-300 dark:border-neutral-600 ${
                viewMode === 'list'
                  ? 'bg-primary-500 text-white'
                  : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
              }`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Photo Grid */}
      {viewMode === 'grid' && (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {photos.map((photo, index) => {
          const isDeleting = deletingPhotos.has(photo.id);
          const commentCount = photo.comment_count ?? 0;
          const averageRating = photo.average_rating ?? 0;
          const likeCount = photo.like_count ?? 0;
          const isVideo = (photo.media_type === 'video') ||
            (photo.mime_type && photo.mime_type.startsWith('video/')) ||
            photo.type === 'video';
          return (
            <div
              key={photo.id}
              data-testid={`admin-photo-tile-${photo.id}`}
              className={`relative group cursor-pointer rounded-lg overflow-hidden bg-neutral-100 dark:bg-neutral-800 transition-opacity ${
                isSelectionMode ? 'ring-2 ring-offset-2 ' + (selectedPhotos.has(photo.id) ? 'ring-primary-500' : 'ring-transparent') : ''
              } ${isDeleting ? 'opacity-50' : ''}`}
              onClick={() => !isDeleting && onPhotoClick(photo, index)}
          >
            {/* Selection Checkbox (top-right) */}
            <button
              type="button"
              aria-label={`Select ${photo.filename}`}
              role="checkbox"
              aria-checked={selectedPhotos.has(photo.id)}
              data-testid={`admin-photo-checkbox-${photo.id}`}
              className={`absolute top-2 right-2 z-20 transition-opacity ${
                selectedPhotos.has(photo.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              onClick={(e) => handlePhotoSelect(photo.id, e)}
            >
              <div className={`w-6 h-6 rounded border-2 flex items-center justify-center ${
                selectedPhotos.has(photo.id)
                  ? 'bg-accent-dark border-accent-dark'
                  : 'bg-white/90 border-white'
              }`}>
                {selectedPhotos.has(photo.id) && <Check className="w-4 h-4 text-white" />}
              </div>
            </button>

            {/* Visibility badge (#172) */}
            {(photo as any).visibility === 'hidden' && (
              <div className="absolute top-2 left-2 z-20">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/90 text-white text-[10px] font-medium">
                  <EyeOff className="w-3 h-3" />
                  {t('admin.photos.hidden', 'Hidden')}
                </span>
              </div>
            )}

            {/* Thumbnail (or processing placeholder for in-flight photos) */}
            <div className="aspect-square">
              {(photo as any).processing_status === 'pending' ||
              (photo as any).processing_status === 'processing' ? (
                <div className="w-full h-full flex flex-col items-center justify-center bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 gap-1 px-2 text-center">
                  <Cog className="w-7 h-7 animate-spin" />
                  <p className="text-[10px] font-medium leading-tight">
                    {t('admin.photos.processingStatus', 'Processing…')}
                  </p>
                </div>
              ) : (photo as any).processing_status === 'failed' ? (
                <div className="w-full h-full flex flex-col items-center justify-center bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 gap-1 px-2 text-center">
                  <AlertTriangle className="w-7 h-7" />
                  <p className="text-[10px] font-medium leading-tight">
                    {t('admin.photos.processingFailed', 'Failed')}
                  </p>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await uploadsService.retryPhoto(photo.id);
                        toast.success(t('admin.photos.retryQueued', 'Retry queued'));
                        // Refetch grid via React Query so the placeholder
                        // updates without a full reload.
                        queryClient.invalidateQueries({ queryKey: ['admin-event-photos'] });
                      } catch (err: any) {
                        toast.error(err?.response?.data?.error || 'Retry failed');
                      }
                    }}
                    className="mt-1 px-2 py-0.5 rounded bg-red-200 dark:bg-red-800 text-[10px] inline-flex items-center gap-1"
                  >
                    <RefreshCw className="w-2.5 h-2.5" />
                    {t('upload.retryFailed', 'Retry')}
                  </button>
                </div>
              ) : photo.thumbnail_url ? (
                <AdminAuthenticatedImage
                  src={photo.thumbnail_url}
                  alt={photo.filename}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  fallback={
                    <div className="w-full h-full flex items-center justify-center text-neutral-400">
                      <Eye className="w-8 h-8" />
                    </div>
                  }
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-neutral-400">
                  <Eye className="w-8 h-8" />
                </div>
              )}
            </div>

            {/* Overlay with actions */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="absolute bottom-0 left-0 right-0 p-3">
                <p className="text-white text-xs font-medium truncate mb-1">
                  {photo.filename}
                </p>
                {photo.original_filename && photo.original_filename !== photo.filename && (
                  <p className="text-white/60 text-[10px] truncate mb-1">
                    Original: {photo.original_filename}
                  </p>
                )}
                <p className="text-white/80 text-xs mb-2">
                  {photosService.formatBytes(photo.size)}
                </p>
                
                {!isSelectionMode && (
                  <div className="flex gap-1">
                    <button
                      onClick={(e) => handleDownload(photo, e)}
                      className="p-1 text-white hover:bg-white/20 rounded"
                    >
                      <Download className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => handleDeleteSingle(photo, e)}
                      className="p-1 text-white hover:bg-white/20 rounded disabled:opacity-50"
                      disabled={isDeleting}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Category Badge - move to top-left and prevent overlap with select checkbox */}
            {photo.category_name && (
              <div className="absolute left-2 top-2 pointer-events-none">
                <span className="px-2 py-1 text-xs font-medium bg-white/90 text-neutral-700 rounded max-w-[70%] whitespace-nowrap overflow-hidden text-ellipsis">
                  {photo.category_name}
                </span>
              </div>
            )}

            {isVideo && (
              <div className="absolute bottom-2 left-2 pointer-events-none">
                <span className="px-2 py-1 text-[11px] font-semibold bg-black/70 text-white rounded flex items-center gap-1">
                  <Video className="w-3 h-3" />
                  {t('common.video', 'Video')}
                </span>
              </div>
            )}
            
            {/* Feedback Indicators (moved to bottom-right to avoid covering category) */}
            {(commentCount > 0 || averageRating > 0 || likeCount > 0) && (
              <div className="absolute bottom-2 right-2 flex items-center gap-1 z-10">
                {averageRating > 0 && (
                  <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`Rating: ${Number(averageRating).toFixed(1)}`}>
                    <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
                    <span className="text-xs font-medium text-neutral-700">{Number(averageRating).toFixed(1)}</span>
                  </div>
                )}
                {commentCount > 0 && (
                  <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`${commentCount} comments`}>
                    <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                    <span className="text-xs font-medium text-neutral-700">{commentCount}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          );
        })}
      </div>
      )}

      {/* Photo List */}
      {viewMode === 'list' && (
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        <table className="w-full">
          <thead className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
            <tr>
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {t('admin.photos.columns.photo', 'Photo')}
              </th>
              <th className="hidden lg:table-cell px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {t('admin.photos.columns.category', 'Category')}
              </th>
              <th className="hidden md:table-cell px-3 py-2 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {t('admin.photos.columns.uploaded', 'Uploaded')}
              </th>
              <th className="hidden xl:table-cell px-3 py-2 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {t('admin.photos.columns.engagement', 'Engagement')}
              </th>
              <th className="hidden sm:table-cell px-3 py-2 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {t('admin.photos.columns.feedback', 'Feedback')}
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {t('admin.photos.columns.size', 'Size')}
              </th>
              <th className="w-px px-3 py-2 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {t('admin.photos.columns.actions', 'Actions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-700">
            {photos.map((photo, index) => {
              const isRowDeleting = deletingPhotos.has(photo.id);
              const commentCount = photo.comment_count ?? 0;
              const averageRating = photo.average_rating ?? 0;
              const viewCount = photo.view_count ?? 0;
              const downloadCount = photo.download_count ?? 0;
              const likeCount = photo.like_count ?? 0;
              const isSelected = selectedPhotos.has(photo.id);
              const isVideo = (photo.media_type === 'video') ||
                (photo.mime_type && photo.mime_type.startsWith('video/')) ||
                photo.type === 'video';
              const isHidden = (photo as any).visibility === 'hidden';
              const status = (photo as any).processing_status;
              return (
                <tr
                  key={photo.id}
                  data-testid={`admin-photo-row-${photo.id}`}
                  className={`group cursor-pointer transition-colors ${
                    isSelected ? 'bg-primary-50 dark:bg-primary-900/20' : 'hover:bg-neutral-50 dark:hover:bg-neutral-700/50'
                  } ${isRowDeleting ? 'opacity-50' : ''}`}
                  onClick={() => !isRowDeleting && onPhotoClick(photo, index)}
                >
                  {/* Selection checkbox */}
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      aria-label={`Select ${photo.filename}`}
                      role="checkbox"
                      aria-checked={isSelected}
                      data-testid={`admin-photo-row-checkbox-${photo.id}`}
                      onClick={(e) => handlePhotoSelect(photo.id, e)}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                        isSelected
                          ? 'bg-accent-dark border-accent-dark'
                          : 'border-neutral-300 dark:border-neutral-500 group-hover:border-neutral-400'
                      }`}>
                        {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                      </div>
                    </button>
                  </td>

                  {/* Thumbnail + filename + badges */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0 w-10 h-10 rounded overflow-hidden bg-neutral-100 dark:bg-neutral-700">
                        {status === 'pending' || status === 'processing' ? (
                          <div className="w-full h-full flex items-center justify-center text-amber-600 dark:text-amber-300">
                            <Cog className="w-4 h-4 animate-spin" />
                          </div>
                        ) : status === 'failed' ? (
                          <div className="w-full h-full flex items-center justify-center text-red-600 dark:text-red-300">
                            <AlertTriangle className="w-4 h-4" />
                          </div>
                        ) : photo.thumbnail_url ? (
                          <AdminAuthenticatedImage
                            src={photo.thumbnail_url}
                            alt={photo.filename}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            fallback={
                              <div className="w-full h-full flex items-center justify-center text-neutral-400">
                                <Eye className="w-4 h-4" />
                              </div>
                            }
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-neutral-400">
                            <Eye className="w-4 h-4" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">
                            {photo.filename}
                          </p>
                          {isVideo && (
                            <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-600 text-neutral-700 dark:text-neutral-200 text-[10px] font-medium">
                              <Video className="w-3 h-3" />
                              {t('common.video', 'Video')}
                            </span>
                          )}
                          {isHidden && (
                            <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 text-[10px] font-medium">
                              <EyeOff className="w-3 h-3" />
                              {t('admin.photos.hidden', 'Hidden')}
                            </span>
                          )}
                        </div>
                        {photo.original_filename && photo.original_filename !== photo.filename && (
                          <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                            {photo.original_filename}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Category */}
                  <td className="hidden lg:table-cell px-3 py-2 max-w-[12rem] truncate text-sm text-neutral-600 dark:text-neutral-400">
                    {photo.category_name || '—'}
                  </td>

                  {/* Uploaded date */}
                  <td className="hidden md:table-cell px-3 py-2 whitespace-nowrap text-sm text-neutral-600 dark:text-neutral-400">
                    {photo.uploaded_at ? formatDate(photo.uploaded_at) : '—'}
                  </td>

                  {/* Engagement: views / downloads / likes */}
                  <td className="hidden xl:table-cell px-3 py-2 text-right text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
                    <div className="flex items-center justify-end gap-3">
                      <span className="inline-flex items-center gap-1" title={t('admin.photos.columns.views', 'Views')}>
                        <Eye className="w-3.5 h-3.5" />
                        {viewCount}
                      </span>
                      <span className="inline-flex items-center gap-1" title={t('admin.photos.columns.downloads', 'Downloads')}>
                        <Download className="w-3.5 h-3.5" />
                        {downloadCount}
                      </span>
                      <span className="inline-flex items-center gap-1" title={t('admin.photos.columns.likes', 'Likes')}>
                        <Heart className="w-3.5 h-3.5" />
                        {likeCount}
                      </span>
                    </div>
                  </td>

                  {/* Feedback: rating + comments */}
                  <td className="hidden sm:table-cell px-3 py-2 text-right text-xs text-neutral-600 dark:text-neutral-400">
                    {averageRating > 0 || commentCount > 0 ? (
                      <div className="flex items-center justify-end gap-2">
                        {averageRating > 0 && (
                          <span className="inline-flex items-center gap-0.5" title={`Rating: ${Number(averageRating).toFixed(1)}`}>
                            <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
                            {Number(averageRating).toFixed(1)}
                          </span>
                        )}
                        {commentCount > 0 && (
                          <span className="inline-flex items-center gap-0.5" title={`${commentCount} comments`}>
                            <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                            {commentCount}
                          </span>
                        )}
                      </div>
                    ) : '—'}
                  </td>

                  {/* Size */}
                  <td className="px-3 py-2 text-right text-sm text-neutral-500 dark:text-neutral-400 whitespace-nowrap tabular-nums">
                    {photosService.formatBytes(photo.size)}
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {!isSelectionMode && (
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => handleDownload(photo, e)}
                          className="p-1.5 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-600 rounded"
                          title={t('common.download', 'Download')}
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => handleDeleteSingle(photo, e)}
                          className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 rounded disabled:opacity-50"
                          disabled={isRowDeleting}
                          title={t('common.delete', 'Delete')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {photos.length === 0 && (
        <div className="text-center py-12">
          <p className="text-neutral-500 dark:text-neutral-400">{t('gallery.noMedia', 'No media uploaded yet')}</p>
        </div>
      )}

      {/* Bulk Category Modal */}
      <BulkCategoryModal
        isOpen={isCategoryModalOpen}
        onClose={() => setIsCategoryModalOpen(false)}
        onConfirm={handleMoveToCategory}
        photoCount={selectedPhotos.size}
        categories={categories}
        isLoading={isUpdatingCategory}
      />
    </div>
  );
};
