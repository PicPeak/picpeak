import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Upload, X, Image, Loader2, Cog } from 'lucide-react';
import { Button } from '../common';
import { clsx } from 'clsx';
import { api } from '../../config/api';
import { toast } from 'react-toastify';
import { useQuery } from '@tanstack/react-query';
import { categoriesService } from '../../services/categories.service';
import { settingsService } from '../../services/settings.service';
import { useTranslation } from 'react-i18next';
import { extensionsToMimeTypes, extensionsToAcceptString } from '../../utils/fileTypes';
import { useUploadProgress } from '../../hooks/useUploadProgress';

interface PhotoUploadProps {
  eventId: number;
  onUploadComplete?: () => void;
}

const DEFAULT_MAX_FILES_PER_UPLOAD = 500;
const MAX_FILES_PER_UPLOAD_LIMIT = 2000;

// Upload phase machine. The user perceives "frozen" during 'processing'
// because the bytes are already on the server and we're waiting for
// thumbnail/EXIF/etc. work — the explicit phase + hint message kills
// that perception (#352 / contributor analysis on issue 357 review).
type UploadPhase =
  | { kind: 'idle' }
  | { kind: 'transferring'; chunkIndex: number; totalChunks: number; bytePct: number }
  | { kind: 'processing'; chunkIndex: number; totalChunks: number; filesInChunk: number };

export const PhotoUpload: React.FC<PhotoUploadProps> = ({ eventId, onUploadComplete }) => {
  const { t } = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [replaceByName, setReplaceByName] = useState(false);
  // Upload IDs returned from each chunk POST. The processing tracker
  // hook merges status across all of them so the user sees one unified
  // progress count even when the upload spans multiple HTTP requests.
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { aggregate: processingAggregate } = useUploadProgress(uploadIds, {
    enabled: phase.kind === 'processing' && uploadIds.length > 0,
  });
  
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

  const remainingSlots = Math.max(maxFilesPerUpload - selectedFiles.length, 0);
  const [isDragOver, setIsDragOver] = useState(false);

  // Shared filter + per-upload-limit pipeline used by both the file-input
  // change handler and the drop handler. #504 — without the drop handler
  // the dashed-border zone looked draggable but silently fell through to
  // the browser's default "open the file in a new tab" behaviour.
  const addFiles = (incoming: File[]) => {
    const imageFiles = incoming.filter((file) => allowedMimeTypes.includes(file.type));
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

  const handleUpload = async () => {
    if (selectedFiles.length === 0) return;
    
    // Validate file count
    if (selectedFiles.length > maxFilesPerUpload) {
      toast.error(
        t('upload.tooManyFiles', { limit: maxFilesPerUpload }) ||
        `Maximum ${maxFilesPerUpload} files can be uploaded at once`
      );
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setUploadIds([]);

    // For large uploads, chunk the files by both count AND size to prevent memory/network issues.
    // #509: the per-chunk byte cap MUST be tunable so users behind Cloudflare Tunnel and other
    // reverse proxies with request-size limits can drop it below their proxy's cap. Falls back
    // to 95MB (Cloudflare-safe headroom under 100MB) when the setting is unset — that matches
    // the value the migration seeds and is what worked in #208's resolution.
    const MAX_FILES_PER_CHUNK = Math.max(1, Math.min(50, maxFilesPerUpload)); // Max 50 files per chunk
    const maxBatchSizeMb = Number(settings?.general_max_upload_batch_size_mb) || 95;
    const MAX_BYTES_PER_CHUNK = maxBatchSizeMb * 1024 * 1024;
    const chunks: File[][] = [];

    let currentChunk: File[] = [];
    let currentChunkSize = 0;

    for (const file of selectedFiles) {
      // Start a new chunk if adding this file would exceed limits
      if (currentChunk.length >= MAX_FILES_PER_CHUNK ||
          (currentChunkSize + file.size > MAX_BYTES_PER_CHUNK && currentChunk.length > 0)) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChunkSize = 0;
      }

      currentChunk.push(file);
      currentChunkSize += file.size;
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    setTotalChunks(chunks.length);
    let totalUploaded = 0;
    let totalReplaced = 0;
    let failedFiles = [];

    try {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        setCurrentChunk(chunkIndex + 1);
        const chunk = chunks[chunkIndex];
        const formData = new FormData();

        chunk.forEach((file) => {
          formData.append('photos', file);
        });

        if (selectedCategoryId) {
          formData.append('category_id', selectedCategoryId.toString());
        }
        if (replaceByName) {
          formData.append('replace_by_name', 'true');
        }

        setPhase({
          kind: 'transferring',
          chunkIndex,
          totalChunks: chunks.length,
          bytePct: 0,
        });

        try {
          const response = await api.post(`/admin/events/${eventId}/upload`, formData, {
            onUploadProgress: (progressEvent) => {
              if (progressEvent.total) {
                const chunkProgress = progressEvent.loaded / progressEvent.total;
                const overallProgress = ((chunkIndex + chunkProgress) / chunks.length) * 100;
                setUploadProgress(Math.round(overallProgress));

                // Once bytes have all left the browser, the request is
                // sitting in the backend processing pipeline. Flip to
                // 'processing' so the UI explains the wait instead of
                // looking frozen at the chunk's max progress.
                if (chunkProgress >= 1) {
                  setPhase((prev) =>
                    prev.kind === 'transferring' && prev.chunkIndex === chunkIndex
                      ? {
                          kind: 'processing',
                          chunkIndex,
                          totalChunks: chunks.length,
                          filesInChunk: chunk.length,
                        }
                      : prev
                  );
                } else {
                  setPhase({
                    kind: 'transferring',
                    chunkIndex,
                    totalChunks: chunks.length,
                    bytePct: Math.round(chunkProgress * 100),
                  });
                }
              }
            },
          });

          totalUploaded += (response.data?.successCount || chunk.length);
          totalReplaced += (response.data?.replacedCount || 0);
          // Backend returns a per-request upload_id. Track it so the
          // processing-status hook can poll/stream live progress.
          if (response.data?.upload_id) {
            const newId = response.data.upload_id as string;
            setUploadIds((prev) => (prev.includes(newId) ? prev : [...prev, newId]));
          }
        } catch (error: any) {
          console.error(`Error uploading chunk ${chunkIndex + 1}:`, error);
          failedFiles.push(...chunk.map(f => f.name));

          // Continue with next chunk even if one fails
          continue;
        }
      }

      // Bytes are all on the server. Clear the file picker so the
      // user can queue another batch — but DON'T dismiss the upload
      // UI yet; we'll watch the processing aggregate (useEffect below)
      // to know when the backend has finished generating thumbnails
      // and metadata.
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      if (totalReplaced > 0) {
        toast.info(t('upload.replacedFiles', { count: totalReplaced }) || `${totalReplaced} photo(s) replaced`);
      }
      if (failedFiles.length > 0) {
        toast.warning(
          t('upload.someFilesFailed') ||
          `Transferred ${totalUploaded} files. ${failedFiles.length} files failed to transfer.`
        );
      }

      // Refresh the grid early so the user sees their photos appearing
      // as the worker processes them. The processing-aggregate effect
      // below will refresh again on completion.
      if (onUploadComplete) {
        onUploadComplete();
      }

      // If the backend never returned an upload_id (e.g. only failures
      // or pre-async-backend deployment), we have nothing to wait for —
      // fall through to the finally cleanup which resets state.
    } catch (error: any) {
      console.error('Upload error:', error);
      toast.error(error.response?.data?.error || t('toast.uploadError'));
      setIsUploading(false);
      setUploadProgress(0);
      setCurrentChunk(0);
      setTotalChunks(0);
      setPhase({ kind: 'idle' });
      setUploadIds([]);
    }
  };

  // When the background worker finishes processing every photo from
  // this upload, dismiss the upload UI and surface the result.
  useEffect(() => {
    if (!isUploading) return;
    if (uploadIds.length === 0) return;
    if (!processingAggregate.isComplete) return;

    if (processingAggregate.failed > 0) {
      toast.warning(
        t('upload.processingFailed', { count: processingAggregate.failed }) ||
          `${processingAggregate.failed} photo(s) failed to process`
      );
    } else {
      toast.success(
        t('upload.uploadComplete') || `Successfully uploaded ${processingAggregate.complete} photo(s)`
      );
    }

    if (onUploadComplete) onUploadComplete();
    setIsUploading(false);
    setUploadProgress(0);
    setCurrentChunk(0);
    setTotalChunks(0);
    setPhase({ kind: 'idle' });
    setUploadIds([]);
    // We intentionally only react to processingAggregate.isComplete /
    // .failed — the rest of the deps either don't move during this
    // effect's lifetime or are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processingAggregate.isComplete, processingAggregate.failed, isUploading]);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="space-y-4">
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
          {t('upload.fileRequirements', { limit: maxFilesPerUpload })}
        </p>
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
          leftIcon={isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        >
          {isUploading ? t('upload.uploading') : t('common.upload') + ` ${selectedFiles.length} ${t(selectedFiles.length === 1 ? 'common.photo' : 'common.photos')}`}
        </Button>
      </div>

      {/* Progress display — two distinct phases. Bytes-on-wire ('transferring')
          drives the determinate bar; the post-bytes wait ('processing') swaps
          in an indeterminate spinner with an explanatory hint so users don't
          assume the upload froze. */}
      {isUploading && (
        <div className="mt-4">
          {phase.kind === 'processing' ? (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4">
              <div className="flex items-start gap-3">
                <Cog className="w-5 h-5 text-amber-600 dark:text-amber-400 animate-spin shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    {t('upload.processing')}
                  </p>
                  {processingAggregate.total > 0 && (
                    <>
                      <p className="text-xs text-amber-900 dark:text-amber-100 font-medium mt-2">
                        {t('upload.processingProgress', {
                          complete: processingAggregate.complete + processingAggregate.failed,
                          total: processingAggregate.total,
                        })}
                      </p>
                      <div className="w-full bg-amber-100 dark:bg-amber-900/40 rounded-full h-2 mt-1">
                        <div
                          className="bg-amber-600 dark:bg-amber-500 h-2 rounded-full transition-all duration-300"
                          style={{
                            width: `${
                              processingAggregate.total === 0
                                ? 0
                                : Math.round(
                                    ((processingAggregate.complete + processingAggregate.failed) /
                                      processingAggregate.total) *
                                      100
                                  )
                            }%`,
                          }}
                        />
                      </div>
                    </>
                  )}
                  <p className="text-xs text-amber-800 dark:text-amber-200 mt-2">
                    {t('upload.processingHint')}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex justify-between text-sm text-neutral-600 dark:text-neutral-400 mb-1">
                <span>
                  {t('upload.transferring')}
                  {totalChunks > 1 && ` (${t('common.chunk')} ${currentChunk}/${totalChunks})`}
                </span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-2">
                <div
                  className="bg-accent-dark h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              {totalChunks > 1 && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('upload.uploadingChunks', { count: selectedFiles.length, total: totalChunks })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

PhotoUpload.displayName = 'PhotoUpload';
