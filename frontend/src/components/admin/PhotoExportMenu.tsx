import React, { useState } from 'react';
import { Download, FileText, FileSpreadsheet, Archive, FileJson, ChevronDown, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { photosService, ExportOptions, FeedbackFilters } from '../../services/photos.service';
import { ExportPreviewModal } from './ExportPreviewModal';
import { useMutationWithToast, useModal } from '../../hooks';

// TXT + CSV render through the preview modal (with copy-to-clipboard and a
// fallback download button). XMP is a ZIP archive — no textarea preview makes
// sense. JSON stays a direct download because operators consuming it want a
// file for tooling. See #631.
const PREVIEW_FORMATS: ReadonlyArray<'txt' | 'csv'> = ['txt', 'csv'];

interface PhotoExportMenuProps {
  eventId: number;
  selectedPhotoIds: number[];
  filters?: FeedbackFilters;
  disabled?: boolean;
}

const EXPORT_FORMATS = [
  {
    value: 'txt',
    label: 'Filename List (TXT)',
    description: 'Simple text list for Lightroom search',
    icon: FileText
  },
  {
    value: 'csv',
    label: 'Filename List (CSV)',
    description: 'Spreadsheet with metadata',
    icon: FileSpreadsheet
  },
  {
    value: 'xmp',
    label: 'XMP Sidecar Files (ZIP)',
    description: 'Import ratings into Lightroom/Bridge',
    icon: Archive
  },
  {
    value: 'json',
    label: 'Metadata (JSON)',
    description: 'Structured data for automation',
    icon: FileJson
  },
];

export const PhotoExportMenu: React.FC<PhotoExportMenuProps> = ({
  eventId,
  selectedPhotoIds,
  filters,
  disabled = false
}) => {
  const { t } = useTranslation();
  const menuModal = useModal();
  const [preview, setPreview] = useState<{
    format: 'txt' | 'csv';
    content: string;
    filename: string;
  } | null>(null);

  const exportMutation = useMutationWithToast({
    mutationFn: (options: ExportOptions) => photosService.exportPhotos(eventId, options),
    successMessage: t('export.success', 'Export downloaded successfully'),
    onSuccess: () => {
      menuModal.close();
    },
    errorMessage: (error: Error) => t('export.error', 'Export failed: ') + error.message
  });

  const previewMutation = useMutation({
    mutationFn: ({ options, format }: { options: ExportOptions; format: 'txt' | 'csv' }) =>
      photosService.exportPhotosAsText(eventId, options).then((result) => ({
        ...result,
        format,
      })),
    onSuccess: (result) => {
      setPreview(result);
      menuModal.close();
    },
    onError: (error: Error) => {
      toast.error(t('export.error', 'Export failed: ') + error.message);
    },
  });

  // Whose verdict the XMP sidecars carry (#1044 follow-up). Defaults to the
  // client's selections, so existing exports are unchanged.
  const [markSource, setMarkSource] = useState<'client' | 'mine'>('client');

  const handleExport = (format: 'txt' | 'csv' | 'xmp' | 'json') => {
    const options: ExportOptions = {
      format,
      options: {
        filename_format: 'original',
        // TXT is labelled "for Lightroom search" — Lightroom's filename
        // search field takes one comma-separated line, and the gallery
        // JPEGs may correspond to RAW files in the catalog so the search
        // has to match on the stem only (issue #623).
        ...(format === 'txt' ? { separator: 'comma' as const, include_extension: false } : {}),
        include_rating: true,
        include_label: true,
        include_description: true,
        include_keywords: true,
        mark_source: markSource
      }
    };

    // Use selected photos if any, otherwise use filters
    if (selectedPhotoIds.length > 0) {
      options.photo_ids = selectedPhotoIds;
    } else if (filters) {
      // Convert camelCase filter keys to snake_case for backend
      options.filter = {
        min_rating: filters.minRating,
        max_rating: filters.maxRating,
        has_likes: filters.hasLikes,
        min_likes: filters.minLikes,
        has_favorites: filters.hasFavorites,
        min_favorites: filters.minFavorites,
        has_comments: filters.hasComments,
        // #1044 — lets "export only the greens" round-trip to Lightroom.
        color_labels: filters.colorLabels?.length ? filters.colorLabels : undefined,
        my_color_labels: filters.myColorLabels?.length ? filters.myColorLabels : undefined,
        category_id: filters.categoryId,
        logic: filters.logic,
        sort: filters.sort,
        order: filters.order,
      };
    }

    if ((PREVIEW_FORMATS as readonly string[]).includes(format)) {
      previewMutation.mutate({ options, format: format as 'txt' | 'csv' });
    } else {
      exportMutation.mutate(options);
    }
  };

  const hasSelection = selectedPhotoIds.length > 0;
  const hasFilters = filters && (
    filters.minRating !== null ||
    filters.hasLikes ||
    filters.hasFavorites ||
    filters.hasComments ||
    (filters.colorLabels?.length || 0) > 0 ||
    (filters.myColorLabels?.length || 0) > 0
  );

  const isDisabled = disabled || (!hasSelection && !hasFilters);
  const isWorking = exportMutation.isPending || previewMutation.isPending;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={menuModal.toggle}
        disabled={isDisabled || isWorking}
        className={`
          inline-flex items-center gap-2 px-4 py-2 rounded-lg border font-medium text-sm
          transition-colors
          ${isDisabled
            ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-400 border-neutral-200 dark:border-neutral-700 cursor-not-allowed'
            : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-700'
          }
        `}
      >
        {isWorking ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
        {t('export.button', 'Export')}
        {hasSelection && (
          <span className="bg-accent-dark/15 text-accent-dark text-xs px-2 py-0.5 rounded-full">
            {selectedPhotoIds.length}
          </span>
        )}
        <ChevronDown className={`w-4 h-4 transition-transform ${menuModal.isOpen ? 'rotate-180' : ''}`} />
      </button>

      {menuModal.isOpen && !isDisabled && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={menuModal.close}
          />

          {/* Dropdown Menu */}
          <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-neutral-800 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-700 z-20">
            <div className="p-2">
              <p className="px-3 py-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                {hasSelection
                  ? t('export.exportSelected', 'Export {{count}} selected', { count: selectedPhotoIds.length })
                  : t('export.exportFiltered', 'Export filtered photos')
                }
              </p>

              {/* Whose stars/colours the XMP sidecars carry (#1044
                  follow-up). Only affects XMP — the CSV and JSON exports
                  carry both columns regardless. */}
              <label className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                <span>{t('export.markSource', 'XMP stars & colour from')}</span>
                <select
                  value={markSource}
                  onChange={(e) => setMarkSource(e.target.value === 'mine' ? 'mine' : 'client')}
                  className="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="client">{t('export.markSourceClient', 'Client selections')}</option>
                  <option value="mine">{t('export.markSourceMine', 'Your marks')}</option>
                </select>
              </label>

              {EXPORT_FORMATS.map((format) => {
                const Icon = format.icon;
                return (
                  <button
                    key={format.value}
                    onClick={() => handleExport(format.value as 'txt' | 'csv' | 'xmp' | 'json')}
                    disabled={isWorking}
                    className="w-full flex items-start gap-3 px-3 py-2 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-700 text-left transition-colors"
                  >
                    <Icon className="w-5 h-5 text-neutral-500 dark:text-neutral-400 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {format.label}
                      </div>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {format.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!hasSelection && !hasFilters && (
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t('export.hint', 'Select photos or apply filters to export')}
        </p>
      )}

      {preview && (
        <ExportPreviewModal
          format={preview.format}
          content={preview.content}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};

export default PhotoExportMenu;
