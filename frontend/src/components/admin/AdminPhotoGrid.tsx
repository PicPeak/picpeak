import React, { useState } from 'react';
import { Check, ClipboardCheck, Download, Trash2, Eye, EyeOff, Heart, Package, MessageSquare, Star, Video, FolderOpen, FolderInput, Cog, AlertTriangle, RefreshCw, LayoutGrid, List, UserRound, X, ThumbsUp, ThumbsDown } from 'lucide-react';
import { COLOR_LABEL_SWATCHES, type ColorLabel } from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { AdminPhoto, type PhotoSortKey } from '../../services/photos.service';
import { photosService } from '../../services/photos.service';
import { uploadsService } from '../../services/uploads.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { getPhotoViewMode, setPhotoViewMode, type PhotoViewMode } from '../../utils/photoViewPrefs';
import { defaultCategoryLabel, isVideoItem, mediaSplitLabel, selectLabel, splitMediaCount } from '../../utils/mediaCounts';
import { Badge, Button, ColumnMenuHeader, useConfirm } from '../common';
import type { ColumnMenuOption } from '../common';
import { PermissionGate } from './PermissionGate';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { BulkCategoryModal } from './BulkCategoryModal';
import { BulkCreditModal } from './BulkCreditModal';
import { FolderPickerModal } from './folders/FolderPickerModal';
import { invalidateFolderViews } from './folders/folderQueries';
import type { GalleryFolder } from '../../services/folders.service';
import { folderPathLabel } from '../../utils/folderTree';

interface CategoryOption {
  id: number;
  name: string;
  // Folders (#1160, issue 1786) are photo_categories rows too; the move
  // dialog leaves them out, they have their own "Move to folder".
  is_folder?: boolean;
}

interface AdminPhotoGridProps {
  photos: AdminPhoto[];
  eventId: number;
  onPhotoClick: (photo: AdminPhoto, index: number) => void;
  onPhotosDeleted: () => void;
  onSelectionChange?: (selectedIds: number[]) => void;
  categories?: CategoryOption[];
  /** The event's folders (issue 1786); "Move to folder" is offered when there are any. */
  folders?: GalleryFolder[];
  // The list's sort, owned by the parent together with the filter bar's
  // select. Without onSortChange the list headers are plain text.
  sortBy?: PhotoSortKey;
  sortOrder?: 'asc' | 'desc';
  onSortChange?: (sort: PhotoSortKey, order: 'asc' | 'desc') => void;
  /** The gallery's owner may approve or reject team members' uploads (issue 743). */
  canModerate?: boolean;
}

// The moderation route takes this many photo ids per request (issue 743).
const MODERATION_BATCH = 500;

export const AdminPhotoGrid: React.FC<AdminPhotoGridProps> = ({
  photos,
  eventId,
  onPhotoClick,
  onPhotosDeleted,
  onSelectionChange,
  categories = [],
  folders = [],
  sortBy,
  sortOrder,
  onSortChange,
  canModerate = false
}) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { format: formatDate } = useLocalizedDate();
  const queryClient = useQueryClient();
  // The same test the tiles below use to tell a video from a photo.
  const videoCount = photos.filter(isVideoItem).length;
  const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());
  // Where a shift-click measures its range from: the last tile clicked without
  // the shift key (#1212). The index is what a range needs — a span of the
  // current ordering — but the id is carried with it so the anchor can prove
  // it still points at the tile it was set on. Filtering or re-sorting leaves
  // index 5 meaning a different photo, and a range measured from a stale
  // anchor selects the wrong span silently, which is worse than not selecting
  // at all. Validating at use beats clearing on every list change: a
  // background refetch hands back an equal list and the anchor stays good.
  const [anchor, setAnchor] = useState<{ index: number; photoId: number } | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletingPhotos, setDeletingPhotos] = useState<Set<number>>(new Set());
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [isUpdatingCategory, setIsUpdatingCategory] = useState(false);
  // Move to folder (issue 1786)
  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [isMovingToFolder, setIsMovingToFolder] = useState(false);
  // Photo credits (#1561)
  const [isCreditModalOpen, setIsCreditModalOpen] = useState(false);
  const [isUpdatingCredit, setIsUpdatingCredit] = useState(false);
  // Layout toggle (Grid / List) persisted per admin via localStorage.
  const [viewMode, setViewMode] = useState<PhotoViewMode>(() => getPhotoViewMode());

  // Retry for a complete video on the placeholder tile (issue 1430, item 6);
  // the grid tile and the list row offer the same control.
  const retryPosterFrame = async (photoId: number) => {
    try {
      await uploadsService.retryPhoto(photoId);
      toast.success(t('admin.photos.retryQueued', 'Retry queued'));
      queryClient.invalidateQueries({ queryKey: ['admin-event-photos'] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Retry failed');
    }
  };

  // Sort menus on the list headers (issue 1739). Each option value is the
  // `sort:order` pair, the same shape the events list uses.
  const sortValue = sortBy && sortOrder ? `${sortBy}:${sortOrder}` : null;
  const NAME_SORT: ColumnMenuOption[] = [
    { value: 'name:asc', label: t('events.sortNameAsc', 'A – Z') },
    { value: 'name:desc', label: t('events.sortNameDesc', 'Z – A') },
  ];
  const UPLOADED_SORT: ColumnMenuOption[] = [
    { value: 'date:desc', label: t('events.sortDateNewest', 'Newest first') },
    { value: 'date:asc', label: t('events.sortDateOldest', 'Oldest first') },
  ];
  const RATING_SORT: ColumnMenuOption[] = [
    { value: 'rating:desc', label: t('admin.photos.sort.ratingHighest', 'Best rated first') },
    { value: 'rating:asc', label: t('admin.photos.sort.ratingLowest', 'Lowest rated first') },
  ];
  const SIZE_SORT: ColumnMenuOption[] = [
    { value: 'size:desc', label: t('admin.photos.sort.sizeLargest', 'Largest first') },
    { value: 'size:asc', label: t('admin.photos.sort.sizeSmallest', 'Smallest first') },
  ];
  const listHeader = (
    label: string,
    cell: string,
    align: 'left' | 'right',
    options?: ColumnMenuOption[],
    menuLabel?: string,
  ) => {
    if (!options || !onSortChange) {
      // The label sits in the same inline-flex box a menu header uses, so
      // plain and sortable headers share one baseline in the row.
      return (
        <th className={`${cell} ${align === 'right' ? 'text-right' : 'text-left'} text-xs`}>
          <span className="inline-flex items-center align-middle font-medium text-muted uppercase tracking-wider">
            {label}
          </span>
        </th>
      );
    }
    const selected = sortValue && options.some((o) => o.value === sortValue) ? sortValue : null;
    return (
      <ColumnMenuHeader
        label={label}
        menuLabel={menuLabel}
        options={options}
        value={selected}
        state={selected ? (sortOrder ?? null) : null}
        onSelect={(value) => {
          const [sort, order] = value.split(':');
          onSortChange(sort as PhotoSortKey, order as 'asc' | 'desc');
        }}
        align={align}
        className={`${cell} text-xs`}
      />
    );
  };

  // Persist on user action only — writing in an effect would re-save the
  // value on every mount (i.e. each time the Photos tab is opened), even
  // when the user never touched the toggle.
  const selectView = (mode: PhotoViewMode) => {
    setViewMode(mode);
    setPhotoViewMode(mode);
  };

  const handlePhotoSelect = (photoId: number, e?: React.MouseEvent, index?: number) => {
    if (e) {
      e.stopPropagation();
    }
    // Auto-enable selection mode when selecting via checkbox
    if (!isSelectionMode) {
      setIsSelectionMode(true);
    }
    const newSelected = new Set(selectedPhotos);

    // Shift-click selects the span from the last plain click to here (#1212),
    // the way every file manager does it. Re-assigning a category across a few
    // hundred imported photos is otherwise a few hundred individual clicks.
    //
    // Extends rather than replaces: the grid already lets you accumulate tiles
    // one at a time, so a range is another addition to that set, not a reset
    // of it. And it only ever adds — dragging a range back over itself to
    // deselect is a different gesture, and guessing at it would make a
    // mis-aimed shift-click destroy a selection instead of growing it.
    const anchorStillValid = anchor !== null && photos[anchor.index]?.id === anchor.photoId;
    if (e?.shiftKey && anchorStillValid && index !== undefined) {
      const from = Math.min(anchor.index, index);
      const to = Math.max(anchor.index, index);
      for (let i = from; i <= to; i++) {
        const photo = photos[i];
        if (photo) newSelected.add(photo.id);
      }
      setSelectedPhotos(newSelected);
      onSelectionChange?.(Array.from(newSelected));
      // Anchor deliberately left where it was, so a second shift-click
      // re-aims the same range from the original point rather than walking
      // the anchor along behind the cursor.
      return;
    }

    if (newSelected.has(photoId)) {
      newSelected.delete(photoId);
    } else {
      newSelected.add(photoId);
    }
    if (index !== undefined) setAnchor({ index, photoId });
    setSelectedPhotos(newSelected);
    onSelectionChange?.(Array.from(newSelected));
  };

  const handleSelectAll = () => {
    let newSelected: Set<number>;
    if (selectedPhotos.size === photos.length) {
      newSelected = new Set();
      // Clearing the selection clears what a range would measure from (#1212
      // review). The anchor is invisible, so an anchor that outlived the
      // selection made the next shift-click reach back into a session the user
      // had already ended and select a range they never started.
      setAnchor(null);
    } else {
      newSelected = new Set(photos.map(p => p.id));
    }
    setSelectedPhotos(newSelected);
    onSelectionChange?.(Array.from(newSelected));
  };

  const handleDeleteSingle = async (photo: AdminPhoto, e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!(await confirm({
      message: t('admin.photos.deleteOneConfirm', 'Delete "{{name}}"? The photo is removed from the gallery for good. This cannot be undone.', { name: photo.filename }),
      variant: 'danger',
      confirmLabel: t('admin.photos.deleteOneAction', 'Delete photo'),
    }))) {
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
    if (!(await confirm({
      message: t('admin.photos.deleteManyConfirm', 'Delete {{count}} photos? They are removed from the gallery. This cannot be undone.', { count }),
      variant: 'danger',
      confirmLabel: t('admin.photos.deleteManyAction', 'Delete {{count}} photos', { count }),
    }))) {
      return;
    }

    setIsDeleting(true);
    const selectedIds = Array.from(selectedPhotos);
    setDeletingPhotos(new Set(selectedIds));
    
    try {
      await photosService.deletePhotos(eventId, selectedIds);
      toast.success(`${count} photo${count > 1 ? 's' : ''} deleted successfully`);
      setSelectedPhotos(new Set());
      setAnchor(null);
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
      setAnchor(null);
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
      setAnchor(null);
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

  const handleMoveToFolder = async (folderId: number | null) => {
    if (selectedPhotos.size === 0) return;
    setIsMovingToFolder(true);
    const selectedIds = Array.from(selectedPhotos);
    try {
      await photosService.bulkUpdatePhotos(eventId, selectedIds, { folder_id: folderId });
      toast.success(t('photos.folders.photosMoved', '{{count}} photos moved to {{folder}}', {
        count: selectedIds.length,
        folder: folderId === null
          ? t('photos.folders.galleryRoot', 'Gallery root')
          : folderPathLabel(folders, folderId),
      }));
      setSelectedPhotos(new Set());
      setAnchor(null);
      setIsSelectionMode(false);
      onSelectionChange?.([]);
      setIsFolderModalOpen(false);
      invalidateFolderViews(queryClient, eventId);
      onPhotosDeleted(); // Refresh the photo list
    } catch (error: unknown) {
      const e = error as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || t('photos.folders.moveFailed', 'The photos could not be moved'));
    } finally {
      setIsMovingToFolder(false);
    }
  };

  // Review of team members' uploads (issue 743): approve publishes them,
  // reject keeps them hidden. Photos not under review are left alone.
  const [isModerating, setIsModerating] = useState(false);
  const selectionUnderReview = photos.some((p) => selectedPhotos.has(p.id) && p.moderation_status);
  const handleModerate = async (action: 'approve' | 'reject') => {
    const selectedIds = photos.filter((p) => selectedPhotos.has(p.id) && p.moderation_status).map((p) => p.id);
    if (selectedIds.length === 0) return;
    setIsModerating(true);
    try {
      let updated = 0;
      for (let i = 0; i < selectedIds.length; i += MODERATION_BATCH) {
        updated += (await photosService.moderatePhotos(eventId, selectedIds.slice(i, i + MODERATION_BATCH), action)).updated;
      }
      toast.success(action === 'approve'
        ? t('photos.review.approved', { count: updated })
        : t('photos.review.rejected', { count: updated }));
      setSelectedPhotos(new Set());
      setAnchor(null);
      setIsSelectionMode(false);
      onSelectionChange?.([]);
      queryClient.invalidateQueries({ queryKey: ['admin-event-photos'] });
      onPhotosDeleted(); // Refresh the photo list
    } catch (error: unknown) {
      const e = error as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || t('photos.review.failed', 'The photos could not be reviewed'));
    } finally {
      setIsModerating(false);
    }
  };

  // "Pending review" / "Rejected" with who uploaded it, on tiles and rows.
  const reviewBadge = (photo: AdminPhoto, tone: 'solid' | 'soft') => {
    if (!photo.moderation_status) return null;
    const pending = photo.moderation_status === 'pending';
    const colors = tone === 'solid'
      ? (pending ? 'bg-warning text-white' : 'bg-danger text-white')
      : (pending
        ? 'bg-warning-soft text-warning-text'
        : 'bg-danger-soft text-danger-text');
    const uploader = photo.uploaded_by_admin?.username;
    return (
      <span
        className={`inline-flex max-w-full items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${colors}`}
        title={(uploader
          ? t('photos.review.uploadedBy', 'Uploaded by {{name}}', { name: uploader })
          : t('photos.review.hiddenUntilApproved', 'Hidden from guests and clients until approved')) as string}
        data-testid={`admin-photo-review-badge-${photo.id}`}
      >
        <ClipboardCheck className="w-3 h-3 shrink-0" />
        <span className="shrink-0">{pending ? t('photos.review.pendingBadge', 'Pending review') : t('photos.review.rejectedBadge', 'Rejected')}</span>
        {uploader && <span className="min-w-0 truncate font-normal opacity-90">· {uploader}</span>}
      </span>
    );
  };

  const handleSetCredit = async (creditName: string | null) => {
    setIsUpdatingCredit(true);
    try {
      await photosService.bulkUpdatePhotos(eventId, Array.from(selectedPhotos), { credit_name: creditName });
      toast.success(creditName === null
        ? t('admin.photos.credit.cleared')
        : t('admin.photos.credit.saved'));
      setIsCreditModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ['admin-photo-credits', eventId] });
      onPhotosDeleted(); // Refresh the photo list
    } catch (error: any) {
      // The server says why a name was refused (e.g. nothing left once sanitised).
      toast.error(error?.response?.data?.error || t('common.error'));
    } finally {
      setIsUpdatingCredit(false);
    }
  };

  return (
    <div>
      {/* Action Bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={isSelectionMode ? "primary" : "outline"}
            size="sm"
            onClick={toggleSelectionMode}
            leftIcon={<Package className="w-4 h-4" />}
          >
            {isSelectionMode ? t('gallery.cancelSelection', 'Cancel Selection') : selectLabel(t, videoCount > 0)}
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
                  <span className="text-sm text-soft">
                    {t('gallery.photosSelected', { count: selectedPhotos.size })}
                  </span>
                  <PermissionGate permission="photos.edit">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsCategoryModalOpen(true)}
                      leftIcon={<FolderOpen className="w-4 h-4" />}
                    >
                      {t('photos.moveToCategory', 'Move to Category')}
                    </Button>
                    {folders.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsFolderModalOpen(true)}
                        leftIcon={<FolderInput className="w-4 h-4" />}
                      >
                        {t('photos.folders.moveToFolder', 'Move to folder…')}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsCreditModalOpen(true)}
                      leftIcon={<UserRound className="w-4 h-4" />}
                    >
                      {t('admin.photos.credit.bulkAction')}
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
                          const ids = Array.from(selectedPhotos);
                          const result = await photosService.bulkUpdatePhotos(eventId, ids, { visibility: 'visible' });
                          // Photos under review only go public through approval (issue 743);
                          // the success line is only true for the ones that changed.
                          const skipped = result?.skipped_under_review ?? 0;
                          if (skipped < ids.length) {
                            toast.success(t('admin.photos.visibleSuccess', 'Photos visible'));
                          }
                          if (skipped > 0) {
                            toast.info(t('photos.review.skippedOnShow', { count: skipped }));
                          }
                          onPhotosDeleted();
                        } catch { toast.error(t('common.error')); }
                      }}
                      leftIcon={<Eye className="w-4 h-4" />}
                    >
                      {t('admin.photos.showSelected', 'Show')}
                    </Button>
                  </PermissionGate>
                  {/* The owner (photos.edit) or a reviewer (photos.review); canModerate
                      is the server's per-gallery answer (issue 743). */}
                  {canModerate && selectionUnderReview && (
                    <PermissionGate permissions={['photos.edit', 'photos.review']}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleModerate('approve')}
                        disabled={isModerating}
                        leftIcon={<Check className="w-4 h-4" />}
                      >
                        {t('photos.review.approve', 'Approve')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleModerate('reject')}
                        disabled={isModerating}
                        leftIcon={<X className="w-4 h-4" />}
                      >
                        {t('photos.review.reject', 'Reject')}
                      </Button>
                    </PermissionGate>
                  )}
                  <PermissionGate permission="photos.delete">
                    <button
                      onClick={handleDeleteSelected}
                      disabled={isDeleting}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-danger hover:opacity-90 disabled:bg-danger rounded-lg flex items-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      {t('gallery.deleteSelected', 'Delete Selected')}
                    </button>
                  </PermissionGate>
                </>
              )}
            </>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          <div className="text-sm text-soft">
            {/* Counted by type once the list holds a video: three clips are
                not "3 photos". A list of photos only reads as it always did. */}
            {videoCount > 0
              ? mediaSplitLabel(t, splitMediaCount(photos.length, videoCount))
              : t('gallery.photosCount', { count: photos.length })}
          </div>
          {/* Layout toggle: Grid / List — radiogroup so a screen reader
              announces the two options as one mutually-exclusive set. */}
          <div className="inline-flex rounded-lg border border-line-strong overflow-hidden" role="radiogroup" aria-label={t('admin.photos.viewMode', 'View mode')}>
            <button
              type="button"
              role="radio"
              onClick={() => selectView('grid')}
              aria-checked={viewMode === 'grid'}
              title={t('admin.photos.gridView', 'Grid view')}
              className={`p-1.5 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-accent-strong text-white'
                  : 'bg-panel text-body hover:bg-hover'
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
              className={`p-1.5 transition-colors border-l border-line-strong ${
                viewMode === 'list'
                  ? 'bg-accent-strong text-white'
                  : 'bg-panel text-body hover:bg-hover'
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
          // Approve / reject tallies across guests (issue 744).
          const approvedCount = photo.approved_count ?? 0;
          const rejectedCount = photo.rejected_count ?? 0;
          const isVideo = (photo.media_type === 'video') ||
            (photo.mime_type && photo.mime_type.startsWith('video/')) ||
            photo.type === 'video';
          const isHidden = (photo as any).visibility === 'hidden';
          return (
            <div
              key={photo.id}
              data-testid={`admin-photo-tile-${photo.id}`}
              className={`relative group cursor-pointer rounded-lg overflow-hidden bg-subtle transition-opacity ${
                isSelectionMode ? 'ring-2 ring-offset-2 ' + (selectedPhotos.has(photo.id) ? 'ring-accent' : 'ring-transparent') : ''
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
              onClick={(e) => handlePhotoSelect(photo.id, e, index)}
            >
              <div className={`w-6 h-6 rounded border-2 flex items-center justify-center ${
                selectedPhotos.has(photo.id)
                  ? 'bg-accent-dark border-accent-dark'
                  : 'bg-white/90 border-white'
              }`}>
                {selectedPhotos.has(photo.id) && <Check className="w-4 h-4 text-white" />}
              </div>
            </button>

            {/* Visibility badge (#172). Same badge vocabulary as the list
                view's row badges — icon + short label, tooltip carrying the
                explanation. It shares the top-left corner with the category
                badge, so that one drops a row while this is showing. */}
            {photo.moderation_status && (
              <div className="absolute top-2 left-2 z-20 flex max-w-[calc(100%-3rem)]">
                {reviewBadge(photo, 'solid')}
              </div>
            )}
            {isHidden && !photo.moderation_status && (
              <div
                className="absolute top-2 left-2 z-20"
                data-testid={`admin-photo-hidden-badge-${photo.id}`}
              >
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-danger text-white text-[10px] font-medium"
                  title={t('admin.photos.hiddenTooltip', 'Hidden from guests — this photo is not shown in the client gallery.') as string}
                >
                  <EyeOff className="w-3 h-3" />
                  {t('admin.photos.hidden', 'Hidden')}
                </span>
              </div>
            )}

            {/* Thumbnail (or processing placeholder for in-flight photos) */}
            <div className="aspect-square">
              {(photo as any).processing_status === 'pending' ||
              (photo as any).processing_status === 'processing' ? (
                <div className="w-full h-full flex flex-col items-center justify-center bg-warning-soft text-warning-text gap-1 px-2 text-center">
                  <Cog className="w-7 h-7 animate-spin" />
                  <p className="text-[10px] font-medium leading-tight">
                    {t('admin.photos.processingStatus', 'Processing…')}
                  </p>
                </div>
              ) : (photo as any).processing_status === 'failed' ? (
                <div className="w-full h-full flex flex-col items-center justify-center bg-danger-soft text-danger-text gap-1 px-2 text-center">
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
                    className="mt-1 px-2 py-0.5 rounded bg-danger-soft text-[10px] inline-flex items-center gap-1"
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
                    <div className="w-full h-full flex items-center justify-center text-faint">
                      <Eye className="w-8 h-8" />
                    </div>
                  }
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-faint">
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
                {photo.credit_name && (
                  <p className="text-white/80 text-[11px] truncate mb-1 flex items-center gap-1" data-testid="admin-photo-credit">
                    <UserRound className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                    {photo.credit_name}
                  </p>
                )}
                <p className="text-white/80 text-xs mb-2">
                  {photosService.formatBytes(photo.size)}
                </p>
                
                {!isSelectionMode && (
                  <div className="flex gap-1">
                    <PermissionGate permission="photos.download">
                      <button
                        onClick={(e) => handleDownload(photo, e)}
                        className="p-1 text-white hover:bg-white/20 rounded"
                      >
                        <Download className="w-3 h-3" />
                      </button>
                    </PermissionGate>
                    <PermissionGate permission="photos.delete">
                      <button
                        onClick={(e) => handleDeleteSingle(photo, e)}
                        className="p-1 text-white hover:bg-white/20 rounded disabled:opacity-50"
                        disabled={isDeleting}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </PermissionGate>
                  </div>
                )}
              </div>
            </div>

            {/* Category Badge - move to top-left and prevent overlap with select checkbox */}
            {defaultCategoryLabel(t, photo) && (
              <div className={`absolute left-2 ${isHidden ? 'top-9' : 'top-2'} pointer-events-none`}>
                <span className="px-2 py-1 text-xs font-medium bg-white/90 text-body rounded max-w-[70%] whitespace-nowrap overflow-hidden text-ellipsis">
                  {defaultCategoryLabel(t, photo)}
                </span>
              </div>
            )}

            {/* A complete video on the placeholder tile (issue 1430, item 6):
                the row is fine, the poster frame is not. Same Retry as the
                failed placeholder above. One row above the video pill and
                the colour label, which own the bottom-left corner, the way
                the category badge drops a row under the hidden badge. */}
            {photo.processing_status === 'complete' && photo.processing_error && (
              <div
                className="absolute bottom-9 left-2 z-20 flex items-center gap-1"
                data-testid={`admin-photo-poster-note-${photo.id}`}
              >
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning text-white text-[10px] font-medium"
                  title={photo.processing_error}
                >
                  <AlertTriangle className="w-3 h-3" />
                  {t('admin.photos.noPosterFrame', 'No poster frame')}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void retryPosterFrame(photo.id); }}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/90 text-body text-[10px] font-medium"
                  title={t('admin.photos.noPosterFrameRetry', 'Take the poster frame again') as string}
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  {t('common.retry', 'Retry')}
                </button>
              </div>
            )}

            {isVideo && (
              <div className="absolute bottom-2 left-2 pointer-events-none flex items-center gap-1">
                <span className="px-2 py-1 text-[11px] font-semibold bg-black/70 text-white rounded flex items-center gap-1">
                  <Video className="w-3 h-3" />
                  {t('common.video', 'Video')}
                </span>
                {/* The browser-playable copy could not be made (issue 1430,
                    item 8): the original still streams, so this is a note,
                    not a failed tile. Switching the setting off and on
                    queues failed copies again. */}
                {photo.web_status === 'failed' && (
                  <span
                    className="px-2 py-1 text-[11px] font-semibold bg-warning text-white rounded flex items-center gap-1"
                    title={photo.web_error || undefined}
                    data-testid={`admin-photo-web-copy-failed-${photo.id}`}
                  >
                    <AlertTriangle className="w-3 h-3" />
                    {t('admin.photos.webCopyFailed', 'No web copy')}
                  </span>
                )}
              </div>
            )}
            
            {/* Color label (#1044). Bottom-left, opposite the rating/comment
                indicators, so a labelled photo reads at a glance in the
                admin grid the same way it does in the client's gallery. */}
            {photo.dominant_color_label && COLOR_LABEL_SWATCHES[photo.dominant_color_label as ColorLabel] && (
              <div className="absolute bottom-2 left-2 z-10">
                <span
                  className="flex items-center justify-center w-5 h-5 rounded-full border-2 border-white/90 shadow"
                  style={{ backgroundColor: COLOR_LABEL_SWATCHES[photo.dominant_color_label as ColorLabel].fill }}
                  role="img"
                  aria-label={t('feedback.markedAs', 'Marked as {{color}}', {
                    color: t(`feedback.colorLabels.${photo.dominant_color_label}`, photo.dominant_color_label),
                  })}
                  title={t('feedback.markedAs', 'Marked as {{color}}', {
                    color: t(`feedback.colorLabels.${photo.dominant_color_label}`, photo.dominant_color_label),
                  })}
                />
              </div>
            )}

            {/* The admin's OWN mark (#1044 follow-up), next to the client's
                dot but visually distinct — a white ring and a star count —
                so a triage pass is never confused with what the client
                chose. */}
            {(photo.my_color_label || photo.my_rating) && (
              <div className="absolute bottom-2 left-9 z-10 flex items-center gap-1">
                {photo.my_color_label && COLOR_LABEL_SWATCHES[photo.my_color_label as ColorLabel] && (
                  <span
                    className="w-5 h-5 rounded-full border-2 border-dashed border-white shadow"
                    style={{ backgroundColor: COLOR_LABEL_SWATCHES[photo.my_color_label as ColorLabel].fill }}
                    role="img"
                    aria-label={t('admin.photos.yourMarkColor', 'Your mark: {{color}}', {
                      color: t(`feedback.colorLabels.${photo.my_color_label}`, photo.my_color_label),
                    })}
                    title={t('admin.photos.yourMarkColor', 'Your mark: {{color}}', {
                      color: t(`feedback.colorLabels.${photo.my_color_label}`, photo.my_color_label),
                    })}
                  />
                )}
                {!!photo.my_rating && (
                  <span
                    className="bg-white/90 backdrop-blur-sm rounded-full px-1.5 py-0.5 text-xs font-medium text-body flex items-center gap-0.5"
                    title={t('admin.photos.yourMarkRating', 'Your rating: {{count}}', { count: photo.my_rating })}
                  >
                    <Star className="w-3 h-3 text-rating" fill="currentColor" />
                    {photo.my_rating}
                  </span>
                )}
              </div>
            )}

            {/* Feedback Indicators (moved to bottom-right to avoid covering category) */}
            {(commentCount > 0 || averageRating > 0 || likeCount > 0 || approvedCount > 0 || rejectedCount > 0) && (
              <div className="absolute bottom-2 right-2 flex items-center gap-1 z-10">
                {approvedCount > 0 && (
                  <div
                    className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1"
                    title={t('admin.photos.approvedBy', 'Approved: {{value}}', { value: approvedCount })}
                  >
                    <ThumbsUp className="w-3.5 h-3.5 text-success-text" aria-hidden="true" />
                    <span className="text-xs font-medium text-body">{approvedCount}</span>
                  </div>
                )}
                {rejectedCount > 0 && (
                  <div
                    className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1"
                    title={t('admin.photos.rejectedBy', 'Rejected: {{value}}', { value: rejectedCount })}
                  >
                    <ThumbsDown className="w-3.5 h-3.5 text-danger-text" aria-hidden="true" />
                    <span className="text-xs font-medium text-body">{rejectedCount}</span>
                  </div>
                )}
                {averageRating > 0 && (
                  <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`Rating: ${Number(averageRating).toFixed(1)}`}>
                    <Star className="w-3.5 h-3.5 text-rating" fill="currentColor" />
                    <span className="text-xs font-medium text-body">{Number(averageRating).toFixed(1)}</span>
                  </div>
                )}
                {commentCount > 0 && (
                  <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`${commentCount} comments`}>
                    <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                    <span className="text-xs font-medium text-body">{commentCount}</span>
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
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full">
          <thead className="bg-subtle border-b border-line">
            <tr>
              <th className="w-8 px-3 py-2" />
              {listHeader(t('admin.photos.columns.photo', 'Photo'), 'px-3 py-2', 'left', NAME_SORT, t('gallery.sortByName', 'Sort by Name'))}
              {listHeader(t('admin.photos.columns.category', 'Category'), 'hidden lg:table-cell px-3 py-2', 'left')}
              {listHeader(t('admin.photos.columns.credit'), 'hidden lg:table-cell px-3 py-2', 'left')}
              {listHeader(t('admin.photos.columns.uploaded', 'Uploaded'), 'hidden md:table-cell px-3 py-2', 'left', UPLOADED_SORT, t('gallery.sortByDate', 'Sort by Date'))}
              {listHeader(t('admin.photos.columns.engagement', 'Engagement'), 'hidden xl:table-cell px-3 py-2', 'right')}
              {listHeader(t('admin.photos.columns.feedback', 'Feedback'), 'hidden sm:table-cell px-3 py-2', 'right', RATING_SORT, t('gallery.sortByRating', 'Sort by Rating'))}
              {listHeader(t('admin.photos.columns.size', 'Size'), 'px-3 py-2', 'right', SIZE_SORT, t('gallery.sortBySize', 'Sort by Size'))}
              {listHeader(t('admin.photos.columns.actions', 'Actions'), 'w-px px-3 py-2', 'right')}
            </tr>
          </thead>
          <tbody className="bg-panel divide-y divide-line">
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
                    isSelected ? 'bg-accent-soft' : 'hover:bg-hover-soft'
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
                      onClick={(e) => handlePhotoSelect(photo.id, e, index)}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                        isSelected
                          ? 'bg-accent-dark border-accent-dark'
                          : 'border-line-strong group-hover:border-faint'
                      }`}>
                        {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                      </div>
                    </button>
                  </td>

                  {/* Thumbnail + filename + badges */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0 w-10 h-10 rounded overflow-hidden bg-inset">
                        {status === 'pending' || status === 'processing' ? (
                          <div className="w-full h-full flex items-center justify-center text-warning-text">
                            <Cog className="w-4 h-4 animate-spin" />
                          </div>
                        ) : status === 'failed' ? (
                          <div className="w-full h-full flex items-center justify-center text-danger-text">
                            <AlertTriangle className="w-4 h-4" />
                          </div>
                        ) : photo.thumbnail_url ? (
                          <AdminAuthenticatedImage
                            src={photo.thumbnail_url}
                            alt={photo.filename}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            fallback={
                              <div className="w-full h-full flex items-center justify-center text-faint">
                                <Eye className="w-4 h-4" />
                              </div>
                            }
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-faint">
                            <Eye className="w-4 h-4" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-heading truncate">
                            {photo.filename}
                          </p>
                          {isVideo && (
                            <span className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-fill text-body text-[10px] font-medium">
                              <Video className="w-3 h-3" />
                              {t('common.video', 'Video')}
                            </span>
                          )}
                          {/* The same note and Retry as the grid tile, for admins on the list view. */}
                          {status === 'complete' && photo.processing_error && (
                            <span
                              className="flex-shrink-0 inline-flex items-center gap-1"
                              data-testid={`admin-photo-poster-note-${photo.id}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning text-white text-[10px] font-medium"
                                title={photo.processing_error}
                              >
                                <AlertTriangle className="w-3 h-3" />
                                {t('admin.photos.noPosterFrame', 'No poster frame')}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); void retryPosterFrame(photo.id); }}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-fill text-body text-[10px] font-medium hover:bg-hover-soft"
                                title={t('admin.photos.noPosterFrameRetry', 'Take the poster frame again') as string}
                              >
                                <RefreshCw className="w-2.5 h-2.5" />
                                {t('common.retry', 'Retry')}
                              </button>
                            </span>
                          )}
                          {photo.moderation_status && (
                            <span className="flex-shrink-0">{reviewBadge(photo, 'soft')}</span>
                          )}
                          {isHidden && !photo.moderation_status && (
                            <Badge
                              tone="danger"
                              className="flex-shrink-0"
                              icon={<EyeOff />}
                              title={t('admin.photos.hiddenTooltip', 'Hidden from guests — this photo is not shown in the client gallery.') as string}
                            >
                              {t('admin.photos.hidden', 'Hidden')}
                            </Badge>
                          )}
                        </div>
                        {photo.original_filename && photo.original_filename !== photo.filename && (
                          <p className="text-xs text-muted truncate">
                            {photo.original_filename}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Category */}
                  <td className="hidden lg:table-cell px-3 py-2 max-w-[12rem] truncate text-sm text-soft">
                    {defaultCategoryLabel(t, photo) || '—'}
                  </td>

                  {/* Credit (#1561) */}
                  <td className="hidden lg:table-cell px-3 py-2 max-w-[12rem] text-sm text-soft">
                    {photo.credit_name ? (
                      <span className="block truncate" title={photo.credit_name}>{photo.credit_name}</span>
                    ) : photo.uploaded_by === 'guest' ? (
                      <span className="text-faint">{t('admin.photos.credit.unnamedGuest')}</span>
                    ) : '—'}
                  </td>

                  {/* Uploaded date */}
                  <td className="hidden md:table-cell px-3 py-2 whitespace-nowrap text-sm text-soft">
                    {photo.uploaded_at ? formatDate(photo.uploaded_at) : '—'}
                  </td>

                  {/* Engagement: views / downloads / likes */}
                  <td className="hidden xl:table-cell px-3 py-2 text-right text-xs text-muted tabular-nums">
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
                  <td className="hidden sm:table-cell px-3 py-2 text-right text-xs text-soft">
                    {averageRating > 0 || commentCount > 0 ? (
                      <div className="flex items-center justify-end gap-2">
                        {averageRating > 0 && (
                          <span className="inline-flex items-center gap-0.5" title={`Rating: ${Number(averageRating).toFixed(1)}`}>
                            <Star className="w-3.5 h-3.5 text-rating" fill="currentColor" />
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
                  <td className="px-3 py-2 text-right text-sm text-muted whitespace-nowrap tabular-nums">
                    {photosService.formatBytes(photo.size)}
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    {!isSelectionMode && (
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <PermissionGate permission="photos.download">
                          <button
                            onClick={(e) => handleDownload(photo, e)}
                            className="p-1.5 text-muted hover:text-heading hover:bg-hover rounded"
                            title={t('common.download', 'Download')}
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        </PermissionGate>
                        <PermissionGate permission="photos.delete">
                          <button
                            onClick={(e) => handleDeleteSingle(photo, e)}
                            className="p-1.5 text-danger hover:text-danger-text hover:bg-danger-soft rounded disabled:opacity-50"
                            disabled={isRowDeleting}
                            title={t('common.delete', 'Delete')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </PermissionGate>
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
          <p className="text-muted">{t('gallery.noMedia', 'No media uploaded yet')}</p>
        </div>
      )}

      {/* Bulk credit (#1561) */}
      <BulkCreditModal
        isOpen={isCreditModalOpen}
        onClose={() => setIsCreditModalOpen(false)}
        onConfirm={handleSetCredit}
        photoCount={selectedPhotos.size}
        isLoading={isUpdatingCredit}
      />

      {/* Move to folder (issue 1786): the gallery root is a target too. */}
      <FolderPickerModal
        isOpen={isFolderModalOpen}
        onClose={() => setIsFolderModalOpen(false)}
        onConfirm={handleMoveToFolder}
        title={t('photos.folders.moveToFolderTitle', 'Move {{count}} photos to a folder', { count: selectedPhotos.size })}
        confirmLabel={t('photos.movePhotos', 'Move Photos')}
        folders={folders}
        allowRoot
        isLoading={isMovingToFolder}
      />

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
