import React, { useState, useRef, useMemo } from 'react';
import { Upload, X, Image, Info } from 'lucide-react';
import { Button } from '../common';
import { clsx } from 'clsx';
import { toast } from 'react-toastify';
import { useQuery } from '@tanstack/react-query';
import { categoriesService } from '../../services/categories.service';
import { settingsService } from '../../services/settings.service';
import { useTranslation } from 'react-i18next';
import { extensionsToMimeTypes, extensionsToAcceptString, extensionsToLabel, normalizeFileMimeType } from '../../utils/fileTypes';
import { useUploadSession } from '../../contexts/UploadSessionContext';

interface PhotoUploadProps {
  eventId: number;
  /** Fired the moment the upload is handed to the session. The host (modal)
   *  closes on it; progress and the failure report live in UploadProgressBar. */
  onUploadStarted?: () => void;
}

const DEFAULT_MAX_FILES_PER_UPLOAD = 500;
const MAX_FILES_PER_UPLOAD_LIMIT = 2000;

export const PhotoUpload: React.FC<PhotoUploadProps> = ({ eventId, onUploadStarted }) => {
  const { t } = useTranslation();
  const { startUpload, isUploading } = useUploadSession();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [replaceByName, setReplaceByName] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch categories for this event
  const { data: categories = [] } = useQuery({
    queryKey: ['event-categories', eventId],
    queryFn: () => categoriesService.getEventCategories(eventId),
  });

  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => settingsService.getAllSettings(),
  });

  const maxFilesPerUpload = React.useMemo(() => {
    const rawValue = settings?.general_max_files_per_upload;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_MAX_FILES_PER_UPLOAD;
    }
    return Math.min(MAX_FILES_PER_UPLOAD_LIMIT, Math.max(1, Math.floor(parsed)));
  }, [settings]);

  const allowedMimeTypes = useMemo(
    () => extensionsToMimeTypes(settings?.general_allowed_file_types),
    [settings?.general_allowed_file_types]
  );

  const acceptString = useMemo(
    () => extensionsToAcceptString(settings?.general_allowed_file_types),
    [settings?.general_allowed_file_types]
  );

  const formatsLabel = useMemo(
    () => extensionsToLabel(settings?.general_allowed_file_types),
    [settings?.general_allowed_file_types]
  );

  const maxFileSizeMb = Number.isFinite(Number(settings?.general_max_file_size_mb))
    ? Number(settings?.general_max_file_size_mb)
    : 50;

  // Videos have their own per-file cap; the photo cap would otherwise block
  // every normal clip. Backend enforces the same two values per request.
  const maxVideoSizeMb = Number.isFinite(Number(settings?.general_max_video_size_mb))
    ? Number(settings?.general_max_video_size_mb)
    : 500;

  const videoUploadsAllowed = allowedMimeTypes.some((type) => type.startsWith('video/'));

  const sizeLimitMbFor = (file: File) =>
    (file.type.startsWith('video/') ? maxVideoSizeMb : maxFileSizeMb);

  const remainingSlots = Math.max(maxFilesPerUpload - selectedFiles.length, 0);
  const [isDragOver, setIsDragOver] = useState(false);

  // Shared filter + per-upload-limit pipeline used by both the file-input
  // change handler and the drop handler. #504 — without the drop handler
  // the dashed-border zone looked draggable but silently fell through to
  // the browser's default "open the file in a new tab" behaviour.
  const addFiles = (incoming: File[]) => {
    const imageFiles = incoming.filter((file) => {
      if (!allowedMimeTypes.includes(normalizeFileMimeType(file.name, file.type))) return false;
      // Pre-flight size check, mirroring the guest uploader: without it the
      // admin streams the whole oversized file before the backend 400s it.
      const limitMb = sizeLimitMbFor(file);
      if (file.size > limitMb * 1024 * 1024) {
        toast.error(t('upload.fileTooLarge', { name: file.name, limit: limitMb }));
        return false;
      }
      return true;
    });
    if (imageFiles.length === 0) return;

    const totalFiles = selectedFiles.length + imageFiles.length;
    if (totalFiles > maxFilesPerUpload) {
      const allowedNewFiles = maxFilesPerUpload - selectedFiles.length;
      if (allowedNewFiles <= 0) {
        toast.error(
          t('upload.maxFilesReached', { limit: maxFilesPerUpload }) ||
          `Maximum ${maxFilesPerUpload} files allowed`
        );
        return;
      }
      toast.warning(
        t('upload.someFilesSkipped', { allowed: allowedNewFiles, limit: maxFilesPerUpload }) ||
        `Only ${allowedNewFiles} more files can be added (limit ${maxFilesPerUpload})`
      );
      setSelectedFiles((prev) => [...prev, ...imageFiles.slice(0, allowedNewFiles)]);
      return;
    }

    setSelectedFiles((prev) => [...prev, ...imageFiles]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []));
    // Reset the input so picking the same files again still fires onChange.
    if (e.target.value) e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // dropEffect must be set on every dragover for the cursor to render
    // the "copy" affordance in Chrome/Firefox.
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // dragleave fires for every child node the cursor passes — only flip
    // the highlight off when the cursor leaves the zone itself, otherwise
    // it strobes on/off as the user moves over the icon and text.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    addFiles(files);
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleUpload = () => {
    if (selectedFiles.length === 0 || isUploading) return;

    // Validate file count
    if (selectedFiles.length > maxFilesPerUpload) {
      toast.error(
        t('upload.tooManyFiles', { limit: maxFilesPerUpload }) ||
        `Maximum ${maxFilesPerUpload} files can be uploaded at once`
      );
      return;
    }

    // #509: the per-chunk byte cap MUST be tunable so users behind Cloudflare Tunnel and other
    // reverse proxies with request-size limits can drop it below their proxy's cap. Falls back
    // to 95MB (Cloudflare-safe headroom under 100MB) when the setting is unset — that matches
    // the value the migration seeds and is what worked in #208's resolution.
    const maxBatchSizeMb = Number(settings?.general_max_upload_batch_size_mb) || 95;

    startUpload({
      eventId,
      files: selectedFiles,
      categoryId: selectedCategoryId,
      replaceByName,
      maxFilesPerChunk: Math.max(1, Math.min(50, maxFilesPerUpload)), // Max 50 files per chunk
      maxBytesPerChunk: maxBatchSizeMb * 1024 * 1024,
    });

    setSelectedFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onUploadStarted?.();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="space-y-4">
      {/* One session at a time: the bar tracks a single upload, so a second
          one waits until it is through. */}
      {isUploading && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/60 p-3 text-sm text-neutral-700 dark:text-neutral-300"
        >
          <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-neutral-500" />
          <p>{t('upload.alreadyRunning', 'An upload is already running. It has to finish before the next one can start.')}</p>
        </div>
      )}

      {/* Category Selection */}
      <div>
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
          {t('upload.photoCategory')}
        </label>
        <select
          value={selectedCategoryId || ''}
          onChange={(e) => setSelectedCategoryId(e.target.value ? Number(e.target.value) : null)}
          className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500"
        >
          <option value="">{t('upload.noCategory')}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name} {!category.is_global && t('upload.eventSpecific')}
            </option>
          ))}
        </select>
      </div>

      {/* Replace by name toggle */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="replace-by-name"
          checked={replaceByName}
          onChange={(e) => setReplaceByName(e.target.checked)}
          className="rounded border-neutral-300 text-accent focus:ring-primary-500"
        />
        <label htmlFor="replace-by-name" className="text-sm text-neutral-700 dark:text-neutral-300">
          {t('upload.replaceByName', 'Replace existing photos with same name')}
        </label>
      </div>

      {/* File Input Area — accepts both click-to-pick and drag-and-drop (#504). */}
      <div
        className={clsx(
          "border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
          "hover:border-accent-dark hover:bg-accent-dark/15",
          isDragOver
            ? "border-accent-dark bg-accent-dark/25"
            : selectedFiles.length > 0
              ? "border-accent-dark bg-accent-dark/15"
              : "border-neutral-300 dark:border-neutral-600"
        )}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Upload className="w-12 h-12 mx-auto text-neutral-400 dark:text-neutral-500 mb-4" />
        <p className="text-neutral-700 dark:text-neutral-300 font-medium mb-1">
          {t('upload.clickToUpload')}
        </p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('upload.fileRequirements', { formats: formatsLabel, limit: maxFilesPerUpload, sizeLimit: maxFileSizeMb })}
        </p>
        {videoUploadsAllowed && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('upload.videoSizeLimit', 'Videos: max {{sizeLimit}}MB per file', { sizeLimit: maxVideoSizeMb })}
          </p>
        )}
        <p
          className={clsx(
            "text-xs mt-2",
            remainingSlots === 0 ? "text-red-600" : "text-neutral-500 dark:text-neutral-400"
          )}
        >
          {remainingSlots === 0
            ? t('upload.limitReached', { limit: maxFilesPerUpload })
            : t('upload.limitInfo', {
                selected: selectedFiles.length,
                limit: maxFilesPerUpload,
                remaining: remainingSlots,
              })}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptString}
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* Selected Files */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {t('upload.selectedFiles')} ({selectedFiles.length})
          </p>
          <div className="max-h-48 overflow-y-auto space-y-2">
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-2 bg-neutral-50 dark:bg-neutral-800 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <Image className="w-5 h-5 text-neutral-400" />
                  <div>
                    <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300 truncate max-w-xs">
                      {file.name}
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(index);
                  }}
                  className="p-1 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upload Button */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={handleUpload}
          disabled={selectedFiles.length === 0 || isUploading}
          leftIcon={<Upload className="w-4 h-4" />}
        >
          {t('common.upload') + ` ${selectedFiles.length} ${t(selectedFiles.length === 1 ? 'common.photo' : 'common.photos')}`}
        </Button>
      </div>
    </div>
  );
};

PhotoUpload.displayName = 'PhotoUpload';
