import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderTree, Upload } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card, Loading } from '../../../components/common';
import { AdminPhotoGrid, AdminPhotoViewer, PhotoFilters, PhotoUploadModal, PhotoFilterPanel, PhotoExportMenu, EventCategoryManager } from '../../../components/admin';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { AdminPhoto, photosService, CREDIT_FILTER_NONE, type PhotoFilters as PhotoFilterParams, type FeedbackFilters, type FilterSummary } from '../../../services/photos.service';
import { ExternalSourceBar } from './ExternalSourceBar';

interface PhotosTabProps {
  event: Event;
  id: string | undefined;
  photos: AdminPhoto[];
  photosLoading: boolean;
  photosError: boolean;
  refetchPhotos: () => void;
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
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<number[]>([]);

  // Names on this event's photos, for the credit filter (#1561). Credit
  // edits, uploads, imports and deletions invalidate
  // ['admin-photo-credits', eventId].
  const eventId = parseInt(id!);
  const { data: creditSummary } = useQuery({
    queryKey: ['admin-photo-credits', eventId],
    queryFn: () => photosService.getPhotoCredits(eventId),
    enabled: Number.isFinite(eventId),
  });

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
      />

      {event.source_mode === 'reference' && event.external_path && (
        <ExternalSourceBar event={event} onChangeFolder={onChangeFolder} />
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
        categories={categories}
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
        <div className="flex items-center gap-3">
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
        </div>
        <PermissionGate permission="photos.download">
          <PhotoExportMenu
            eventId={parseInt(id!)}
            selectedPhotoIds={selectedPhotoIds}
            filters={feedbackFilters}
          />
        </PermissionGate>
      </div>

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
          <div className="flex items-start gap-3 text-amber-700 dark:text-amber-400">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t('gallery.failedToLoad')}</p>
              <Button variant="outline" size="sm" onClick={() => refetchPhotos()} className="mt-3">
                {t('common.retry')}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <AdminPhotoGrid
          photos={photos}
          eventId={parseInt(id!)}
          onPhotoClick={(photo, index) => setSelectedPhoto({ photo, index })}
          onPhotosDeleted={() => {
            refetchPhotos();
            queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
            queryClient.invalidateQueries({ queryKey: ['admin-photo-credits', eventId] });
          }}
          onSelectionChange={setSelectedPhotoIds}
          categories={categories}
          sortBy={photoFilters.sort ?? 'date'}
          sortOrder={photoFilters.order ?? 'desc'}
          onSortChange={(sort, order) => setPhotoFilters(prev => ({ ...prev, sort, order }))}
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
            refetchPhotos();
            queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
            queryClient.invalidateQueries({ queryKey: ['admin-photo-credits', eventId] });
            setSelectedPhoto(null);
          }}
          categories={categories}
        />
      )}

    </div>
  );
};
