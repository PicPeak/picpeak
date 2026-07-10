import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Upload, X } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card, Loading } from '../../../components/common';
import { AdminPhotoGrid, AdminPhotoViewer, PhotoFilters, PhotoUploadModal, PhotoFilterPanel, PhotoExportMenu } from '../../../components/admin';
import { externalMediaService } from '../../../services/externalMedia.service';
import { AdminPhoto, type PhotoFilters as PhotoFilterParams, type FeedbackFilters, type FilterSummary } from '../../../services/photos.service';
import { ExternalFolderPicker } from './ExternalFolderPicker';

interface PhotosTabProps {
  event: Event;
  id: string | undefined;
  photos: AdminPhoto[];
  photosLoading: boolean;
  refetchPhotos: () => void;
  categories: Array<{ id: number; name: string; slug: string }>;
  photoFilters: PhotoFilterParams;
  setPhotoFilters: React.Dispatch<React.SetStateAction<PhotoFilterParams>>;
  feedbackFilters: FeedbackFilters;
  setFeedbackFilters: React.Dispatch<React.SetStateAction<FeedbackFilters>>;
  filterSummary: FilterSummary | undefined;
  showMediaFilter: boolean;
}

export const PhotosTab: React.FC<PhotosTabProps> = ({
  event,
  id,
  photos,
  photosLoading,
  refetchPhotos,
  categories,
  photoFilters,
  setPhotoFilters,
  feedbackFilters,
  setFeedbackFilters,
  filterSummary,
  showMediaFilter
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [showPhotoUpload, setShowPhotoUpload] = useState(false);
  const [showExternalImport, setShowExternalImport] = useState(false);
  const [externalPath, setExternalPath] = useState<string>('');
  const [importing, setImporting] = useState<boolean>(false);
  const [selectedPhoto, setSelectedPhoto] = useState<{ photo: AdminPhoto; index: number } | null>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<number[]>([]);

  return (
    <div>
      {/* Photo Upload Modal */}
      <PhotoUploadModal
        isOpen={showPhotoUpload}
        onClose={() => setShowPhotoUpload(false)}
        eventId={parseInt(id!)}
        onUploadComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
          queryClient.invalidateQueries({ queryKey: ['admin-event-photos', id] });
          toast.success(t('toast.uploadSuccess'));
          refetchPhotos();
        }}
      />

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
      />

      {/* Feedback Filter Panel for Export */}
      <PhotoFilterPanel
        filters={feedbackFilters}
        onChange={setFeedbackFilters}
        summary={filterSummary || null}
        isLoading={photosLoading}
      />

      {/* Actions Bar */}
      <div className="mb-4 flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Upload className="w-4 h-4" />}
            onClick={() => setShowPhotoUpload(true)}
          >
            {t('events.uploadPhotos')}
          </Button>
          {event.source_mode === 'reference' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowExternalImport(true)}
            >
              {t('events.importExternal', 'Import from External Folder')}
            </Button>
          )}
        </div>
        <PhotoExportMenu
          eventId={parseInt(id!)}
          selectedPhotoIds={selectedPhotoIds}
          filters={feedbackFilters}
        />
      </div>

      {/* Photo Grid */}
      {photosLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loading size="lg" text={t('events.loadingPhotos')} />
        </div>
      ) : (
        <AdminPhotoGrid
          photos={photos}
          eventId={parseInt(id!)}
          onPhotoClick={(photo, index) => setSelectedPhoto({ photo, index })}
          onPhotosDeleted={() => {
            refetchPhotos();
            queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
          }}
          onSelectionChange={setSelectedPhotoIds}
          categories={categories}
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
            setSelectedPhoto(null);
          }}
          categories={categories}
        />
      )}

      {/* External Import Modal */}
      {showExternalImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-2xl w-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('events.importExternal', 'Import from External Folder')}</h2>
              <button onClick={() => setShowExternalImport(false)} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mb-3 text-sm text-neutral-700 dark:text-neutral-300">
              {t('events.externalImportInfo', 'All pictures from the selected folder will be imported.')}
            </div>
            <div className="mb-2 text-sm text-neutral-700 dark:text-neutral-300">
              {t('events.selectExternalFolder', 'Select external folder under /external-media')}
            </div>
            <ExternalFolderPicker value={externalPath || event.external_path || ''} onChange={setExternalPath} />

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowExternalImport(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                isLoading={importing}
                onClick={async () => {
                  try {
                    setImporting(true);
                    const selected = externalPath || event.external_path || '';
                    if (!selected) {
                      toast.error(t('errors.somethingWentWrong', 'Something went wrong'));
                      return;
                    }
                    await externalMediaService.importEvent(parseInt(id!), selected, { recursive: true });
                    toast.success(t('toast.saveSuccess'));
                    queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
                    queryClient.invalidateQueries({ queryKey: ['admin-event-photos', id] });
                    setShowExternalImport(false);
                  } catch (e: any) {
                    toast.error(e?.response?.data?.error || 'Import failed');
                  } finally {
                    setImporting(false);
                  }
                }}
              >
                {t('events.importFromSelectedFolder', 'Import from selected folder')}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};
