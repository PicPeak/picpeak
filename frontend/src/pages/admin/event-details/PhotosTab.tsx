import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ClipboardCheck, Folders, FolderTree, Trash2, Upload } from 'lucide-react';
import type { Event } from '../../../types';
import { Badge, Button, Card, Loading } from '../../../components/common';
import { AdminPhotoGrid, AdminPhotoViewer, PhotoFilters, PhotoUploadModal, PhotoFilterPanel, PhotoExportMenu, EventCategoryManager, PhotoTrashModal, photoTrashQueryKey } from '../../../components/admin';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { usePermissions } from '../../../contexts/PermissionsContext';
import { AdminPhoto, photosService, CREDIT_FILTER_NONE, type PhotoFilters as PhotoFilterParams, type FeedbackFilters, type FilterSummary } from '../../../services/photos.service';
import { FolderBrowser, FolderRequestsPanel } from '../../../components/admin/folders';
import { folderQueryKey, foldersService } from '../../../services/folders.service';
import { toBoolean } from '../../../utils/parsers';
import { ExternalSourceBar } from './ExternalSourceBar';

interface PhotosTabProps {
  event: Event;
  id: string | undefined;
  photos: AdminPhoto[];
  photosLoading: boolean;
  photosError: boolean;
  refetchPhotos: () => void;
  // Folders are photo_categories rows too (is_folder); since issue 1786 they
  // are managed in the folder bar and never offered as filter categories.
  categories: Array<{ id: number; name: string; slug: string; is_folder?: boolean }>;
  photoFilters: PhotoFilterParams;
  setPhotoFilters: React.Dispatch<React.SetStateAction<PhotoFilterParams>>;
  feedbackFilters: FeedbackFilters;
  setFeedbackFilters: React.Dispatch<React.SetStateAction<FeedbackFilters>>;
  filterSummary: FilterSummary | undefined;
  showMediaFilter: boolean;
  /** Open the categories panel on mount (an old ?tab=categories link). */
  initialCategoriesOpen?: boolean;
  /** Settings → Photo source, where the folder is chosen. */
  onChangeFolder: () => void;
  // From the event's own counts, like showMediaFilter (issue 1430, item 3).
  hasVideos: boolean;
}

export const PhotosTab: React.FC<PhotosTabProps> = ({
  event,
  id,
  photos,
  photosLoading,
  photosError,
  refetchPhotos,
  categories,
  photoFilters,
  setPhotoFilters,
  feedbackFilters,
  setFeedbackFilters,
  filterSummary,
  showMediaFilter,
  initialCategoriesOpen = false,
  onChangeFolder,
  hasVideos
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [showPhotoUpload, setShowPhotoUpload] = useState(false);
  const [showCategories, setShowCategories] = useState(initialCategoriesOpen);
  const [selectedPhoto, setSelectedPhoto] = useState<{ photo: AdminPhoto; index: number } | null>(null);
  // A selection belongs to one event and filter view. Sorting only changes
  // the order, so it does not start a new selection.
  const selectionScope = hashKey([id,
    { ...photoFilters, sort: undefined, order: undefined },
    { ...feedbackFilters, sort: undefined, order: undefined },
  ]);
  const [selection, setSelection] = useState<{ scope: string; ids: number[] }>({ scope: selectionScope, ids: [] });
  const presentPhotoIds = useMemo(() => new Set(photos.map((photo) => photo.id)), [photos]);
  // Errors, including failed background refetches, clear selection along with the grid.
  const selectedPhotoIds = selection.scope !== selectionScope || photosError
    ? []
    : photosLoading ? selection.ids : selection.ids.filter((photoId) => presentPhotoIds.has(photoId));
  // Reset before rendering children, so Export cannot receive old IDs while a
  // new filter loads. Refetches also forget photos that have left the list.
  // This stops after one update: the scope and selected-ID count then match.
  if (selection.scope !== selectionScope || selectedPhotoIds.length !== selection.ids.length) {
    setSelection({ scope: selectionScope, ids: selectedPhotoIds });
  }

  // Names on this event's photos, for the credit filter (#1561). Credit
  // edits, uploads, imports and deletions invalidate
  // ['admin-photo-credits', eventId].
  const eventId = parseInt(id!);
  const { data: creditSummary } = useQuery({
    queryKey: ['admin-photo-credits', eventId],
    queryFn: () => photosService.getPhotoCredits(eventId),
    enabled: Number.isFinite(eventId),
  });

  // Folders (issue 1786): the tree, open folder requests, and whether this
  // admin may edit them.
  const { data: folderTree } = useQuery({
    queryKey: folderQueryKey(eventId),
    queryFn: () => foldersService.list(eventId),
    enabled: Number.isFinite(eventId),
  });
  const folders = useMemo(() => folderTree?.folders ?? [], [folderTree]);
  const folderRequests = folderTree?.requests ?? [];
  const canManageFolders = folderTree?.can_manage === true;
  const folderFilter = photoFilters.folder_id;
  const setFolderFilter = (folder_id: PhotoFilterParams['folder_id']) =>
    setPhotoFilters((prev) => ({ ...prev, folder_id }));
  // The bar shows once the event has folders or requests; before that an
  // admin who may create folders opens it from the actions bar.
  const [folderBarOpened, setFolderBarOpened] = useState(false);
  const showFolderBar = folders.length > 0 || folderRequests.length > 0 || folderFilter !== undefined || folderBarOpened;
  const pendingPhotoCount = folderRequests.reduce((sum, r) => sum + r.photo_count, 0);

  // Review of team members' uploads (issue 743). The owner or a holder of
  // photos.review approves or rejects; a team member sees that their uploads
  // are waiting.
  const canModerate = event.can_review_uploads === true;
  const { data: moderation } = useQuery({
    queryKey: ['admin-event-photos', id, 'moderation'],
    queryFn: () => photosService.getModerationCounts(eventId),
    enabled: Number.isFinite(eventId),
  });

  // The trash (issue 1733): what deleting says depends on its retention, and
  // the button shows how many photos wait there. Same permission as its route.
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canDelete = isSuperAdmin || hasPermission('photos.delete');
  const [showTrash, setShowTrash] = useState(false);
  const { data: trash } = useQuery({
    queryKey: photoTrashQueryKey(eventId),
    queryFn: () => photosService.getTrash(eventId),
    enabled: Number.isFinite(eventId) && canDelete,
  });
  const trashCount = trash?.items.length ?? 0;

  // Deleting, hiding/showing or reviewing photos from this tab changes the
  // review bar's counts too, so every refresh also re-reads them.
  const refreshAfterPhotoChange = () => {
    refetchPhotos();
    queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
    queryClient.invalidateQueries({ queryKey: ['admin-photo-credits', eventId] });
    queryClient.invalidateQueries({ queryKey: ['admin-event-photos', id, 'moderation'] });
    queryClient.invalidateQueries({ queryKey: photoTrashQueryKey(eventId) });
    queryClient.invalidateQueries({ queryKey: ['external-import-status', eventId] });
  };
  const moderationFilter = photoFilters.moderation;
  const setModerationFilter = (value: PhotoFilterParams['moderation']) =>
    setPhotoFilters((prev) => ({ ...prev, moderation: value }));
  const showReviewBar = (moderation?.pending ?? 0) > 0 || (moderation?.rejected ?? 0) > 0 || !!moderationFilter;

  // The open folder was deleted or moved away elsewhere: fall back to all photos.
  useEffect(() => {
    if (typeof folderFilter === 'number' && folderTree && !folders.some((f) => f.id === folderFilter)) {
      setPhotoFilters((prev) => ({ ...prev, folder_id: undefined }));
    }
  }, [folderFilter, folderTree, folders, setPhotoFilters]);

  // Filter categories only: a folder is not something a photo is tagged with.
  const filterCategories = useMemo(() => categories.filter((c) => !c.is_folder), [categories]);

  return (
    <div>
      {/* Photo Upload Modal */}
      {/* Picker only — the upload itself runs in UploadSessionProvider, which
          refreshes this event's queries as photos land and reports the outcome
          in the bar under the header. */}
      <PhotoUploadModal
        isOpen={showPhotoUpload}
        onClose={() => setShowPhotoUpload(false)}
        eventId={parseInt(id!)}
        folderStructureDefault={toBoolean(event.folder_structure, false)}
        defaultFolderId={typeof folderFilter === 'number' ? folderFilter : null}
      />

      {event.source_mode === 'reference' && event.external_path && (
        <ExternalSourceBar
          event={event}
          onChangeFolder={onChangeFolder}
          missingFilter={photoFilters.unavailable === true}
          onToggleMissing={() => setPhotoFilters((prev) => ({ ...prev, unavailable: prev.unavailable ? undefined : true }))}
        />
      )}

      {showReviewBar && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-line bg-warning-soft px-4 py-3"
          data-testid="photo-review-bar"
        >
          <p className="flex items-center gap-2 text-sm text-warning-text">
            <ClipboardCheck className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            {(moderation?.pending ?? 0) > 0
              ? (canModerate
                ? t('photos.review.pendingOwner', { count: moderation?.pending ?? 0 })
                : t('photos.review.pendingMember', { count: moderation?.pending ?? 0 }))
              : t('photos.review.nonePending', 'No uploads are waiting for review.')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={moderationFilter === 'pending' ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setModerationFilter(moderationFilter === 'pending' ? undefined : 'pending')}
              aria-pressed={moderationFilter === 'pending'}
            >
              {t('photos.review.filterPending', { count: moderation?.pending ?? 0 })}
            </Button>
            {(moderation?.rejected ?? 0) > 0 && (
              <Button
                variant={moderationFilter === 'rejected' ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setModerationFilter(moderationFilter === 'rejected' ? undefined : 'rejected')}
                aria-pressed={moderationFilter === 'rejected'}
              >
                {t('photos.review.filterRejected', { count: moderation?.rejected ?? 0 })}
              </Button>
            )}
            {moderationFilter && (
              <Button variant="ghost" size="sm" onClick={() => setModerationFilter(undefined)}>
                {t('photos.review.showAll', 'All photos')}
              </Button>
            )}
          </div>
        </div>
      )}

      <FolderRequestsPanel
        eventId={eventId}
        requests={folderRequests}
        folders={folders}
        canManage={canManageFolders}
        onShowWaiting={() => setFolderFilter('pending')}
      />

      {showFolderBar && (
        <FolderBrowser
          eventId={eventId}
          folders={folders}
          canManage={canManageFolders}
          maxDepth={folderTree?.max_depth ?? 3}
          value={folderFilter}
          onChange={setFolderFilter}
          pendingPhotoCount={pendingPhotoCount}
        />
      )}

      {/* Categories (formerly their own tab): organise into categories next
          to the photos they hold. */}
      {showCategories && (
        <Card padding="md" className="mb-4">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-heading">{t('events.photoCategories')}</h2>
              <p className="text-sm text-soft">{t('events.organizeCategoriesInfo')}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowCategories(false)}>
              {t('common.close', 'Close')}
            </Button>
          </div>
          <EventCategoryManager eventId={parseInt(id!)} />
        </Card>
      )}

      {/* Photo Filters */}
      <PhotoFilters
        categories={filterCategories}
        selectedCategory={photoFilters.category_id}
        searchTerm={photoFilters.search ?? ''}
        sortBy={photoFilters.sort ?? 'date'}
        sortOrder={photoFilters.order ?? 'desc'}
        onCategoryChange={(categoryId) => setPhotoFilters(prev => ({ ...prev, category_id: categoryId }))}
        onSearchChange={(search) => setPhotoFilters(prev => ({ ...prev, search }))}
        onSortChange={(sort, order) => setPhotoFilters(prev => ({ ...prev, sort, order }))}
        mediaType={photoFilters.media_type || 'all'}
        onMediaTypeChange={(mediaType) => setPhotoFilters(prev => ({
          ...prev,
          media_type: mediaType === 'all' ? undefined : mediaType
        }))}
        showMediaFilter={showMediaFilter}
        visibility={photoFilters.visibility ?? 'all'}
        onVisibilityChange={(visibility) => {
          const next = visibility === 'all' ? undefined : visibility;
          if (next === photoFilters.visibility) return;
          setPhotoFilters(prev => ({ ...prev, visibility: next }));
        }}
        credits={creditSummary?.credits}
        creditNoneCount={creditSummary?.none}
        creditNoneValue={CREDIT_FILTER_NONE}
        selectedCredit={photoFilters.credit}
        onCreditChange={(credit) => setPhotoFilters(prev => ({ ...prev, credit }))}
      />

      {/* Feedback Filter Panel for Export */}
      <PhotoFilterPanel
        filters={feedbackFilters}
        onChange={setFeedbackFilters}
        summary={filterSummary || null}
        isLoading={photosLoading}
        hasVideos={hasVideos}
      />

      {/* Actions Bar */}
      <div className="mb-4 flex flex-wrap justify-between items-center gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <PermissionGate permission="photos.upload">
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Upload className="w-4 h-4" />}
              onClick={() => setShowPhotoUpload(true)}
            >
              {(event.video_count ?? 0) > 0 ? t('upload.uploadMedia', 'Upload Photos & Videos') : t('events.uploadPhotos')}
            </Button>
          </PermissionGate>
          <Button
            variant={showCategories ? 'secondary' : 'outline'}
            size="sm"
            leftIcon={<FolderTree className="w-4 h-4" />}
            onClick={() => setShowCategories((open) => !open)}
            aria-expanded={showCategories}
          >
            {t('events.categories')}
          </Button>
          {canManageFolders && !showFolderBar && (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Folders className="w-4 h-4" />}
              onClick={() => setFolderBarOpened(true)}
            >
              {t('photos.folders.title', 'Folders')}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-3">
          {/* Only while deleting goes to the trash, or something is still in it. */}
          {canDelete && ((trash?.retention_days ?? 0) > 0 || trashCount > 0) && (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Trash2 className="w-4 h-4" />}
              onClick={() => setShowTrash(true)}
              data-testid="photo-trash-open"
            >
              {t('admin.photos.trash.title')}
              {trashCount > 0 && <Badge className="ml-2">{trashCount}</Badge>}
            </Button>
          )}
          <PermissionGate permission="photos.download">
            <PhotoExportMenu
              eventId={parseInt(id!)}
              selectedPhotoIds={selectedPhotoIds}
              filters={feedbackFilters}
            />
          </PermissionGate>
        </div>
      </div>

      {canDelete && (
        <PhotoTrashModal
          eventId={eventId}
          open={showTrash}
          onClose={() => setShowTrash(false)}
          // Photos come back with their labels, decisions and folders: the
          // filter panel's sections and the folder counts depend on them.
          onRestored={() => {
            refreshAfterPhotoChange();
            queryClient.invalidateQueries({ queryKey: ['admin-event-filter-summary', id] });
            queryClient.invalidateQueries({ queryKey: folderQueryKey(eventId) });
          }}
        />
      )}

      {/* Photo Grid */}
      {photosLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loading size="lg" text={t('events.loadingPhotos')} />
        </div>
      ) : photosError ? (
        // Without this branch a failed fetch (offline, 5xx) fell through to the
        // grid's "no media uploaded yet" empty state, which reads as "your
        // photos are gone" rather than "we couldn't load them" (QA follow-up).
        <Card padding="lg">
          <div className="flex items-start gap-3 text-warning-text">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t('gallery.failedToLoad')}</p>
              <Button variant="outline" size="sm" onClick={() => refetchPhotos()} className="mt-3">
                {t('common.retry')}
              </Button>
            </div>
          </div>
        </Card>
      ) : photos.length === 0 && photoFilters.visibility ? (
        <Card padding="lg">
          <p className="text-center text-muted">{t('admin.photos.visibility.none', 'No photos match the selected visibility and filters.')}</p>
        </Card>
      ) : (
        <AdminPhotoGrid
          // Reset the range anchor and selection mode for every filter view,
          // including cached lists. Selection itself is shared with Export.
          key={selectionScope}
          photos={photos}
          eventId={parseInt(id!)}
          onPhotoClick={(photo, index) => setSelectedPhoto({ photo, index })}
          onPhotosDeleted={refreshAfterPhotoChange}
          selectedPhotoIds={selectedPhotoIds}
          onSelectionChange={(ids) => setSelection({ scope: selectionScope, ids })}
          categories={filterCategories}
          folders={folders}
          sortBy={photoFilters.sort ?? 'date'}
          sortOrder={photoFilters.order ?? 'desc'}
          onSortChange={(sort, order) => setPhotoFilters(prev => ({ ...prev, sort, order }))}
          canModerate={canModerate}
          trashRetentionDays={trash?.retention_days}
        />
      )}

      {/* Photo Viewer */}
      {selectedPhoto && (
        <AdminPhotoViewer
          photos={photos}
          initialIndex={selectedPhoto.index}
          eventId={parseInt(id!)}
          onClose={() => setSelectedPhoto(null)}
          onPhotoDeleted={() => {
            refreshAfterPhotoChange();
            setSelectedPhoto(null);
          }}
          categories={filterCategories}
          // Photo sales: per-photo price editor for priced
          // galleries (override of the gallery default).
          photoPricing={{
            isPriced: !!event.is_priced,
            defaultPrice: Number(event.photo_price ?? 0),
          }}
          trashRetentionDays={trash?.retention_days}
        />
      )}

    </div>
  );
};
