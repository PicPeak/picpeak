import React, { useState, useMemo } from 'react';
import { Upload, X, CheckCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Button } from '../common';
import { api } from '../../config/api';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { extensionsToMimeTypes, extensionsToAcceptString } from '../../utils/fileTypes';

interface UserPhotoUploadProps {
  eventId: number;
  categoryId: number | null | undefined;
  onUploadComplete: () => void;
  onClose: () => void;
}

export const UserPhotoUpload: React.FC<UserPhotoUploadProps> = ({
  eventId,
  categoryId,
  onUploadComplete,
  onClose,
}) => {
  const { t } = useTranslation();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ [key: string]: number }>({});
  // Per-file processing state — flips to true once axios reports
  // bytes-on-wire for that file, so the UI can show "Processing…"
  // instead of a static 100% bar while the backend works.
  const [processingFiles, setProcessingFiles] = useState<{ [key: string]: boolean }>({});
  const [isDragOver, setIsDragOver] = useState(false);

  const { data: publicSettings } = usePublicSettings();

  // #613 — guest upload UI was hardcoded to behave as if the limit was
  // unlimited (no client-side guard) and the fileRequirements hint
  // rendered `{{limit}}` literally because t() was called with no
  // interpolation argument. publicSettings now surfaces
  // general_max_files_per_upload (default 500 from publicSettings.js)
  // so we can render a real number and refuse oversized batches before
  // they hit the backend. Backend route enforces the same value too.
  const maxFilesPerUpload = Number.isFinite(Number(publicSettings?.general_max_files_per_upload))
    ? Number(publicSettings?.general_max_files_per_upload)
    : 500;

  const allowedMimeTypes = useMemo(
    () => extensionsToMimeTypes(publicSettings?.allowed_file_types),
    [publicSettings?.allowed_file_types]
  );

  const acceptString = useMemo(
    () => extensionsToAcceptString(publicSettings?.allowed_file_types),
    [publicSettings?.allowed_file_types]
  );

  // Shared filter pipeline for both <input> change and drag-and-drop (#504).
  const addFiles = (incoming: File[]) => {
    const validFiles = incoming.filter((file) => {
      if (!allowedMimeTypes.includes(file.type)) {
        toast.error(`Invalid file type: ${file.name}`);
        return false;
      }
      // Check file size (50MB max)
      if (file.size > 50 * 1024 * 1024) {
        toast.error(`File too large: ${file.name}`);
        return false;
      }
      return true;
    });
    if (validFiles.length === 0) return;

    // #613 — per-batch file count guard. Mirrors what the admin's
    // PhotoUpload component does. Backend also enforces, so this is
    // purely UX (saves a multi-MB POST when the user clearly went over).
    const remaining = Math.max(0, maxFilesPerUpload - files.length);
    if (remaining === 0) {
      toast.error(t('upload.limitReached', { limit: maxFilesPerUpload }));
      return;
    }
    if (validFiles.length > remaining) {
      toast.warning(t('upload.someFilesSkipped', { allowed: remaining, limit: maxFilesPerUpload }));
      setFiles((prev) => [...prev, ...validFiles.slice(0, remaining)]);
      return;
    }
    setFiles((prev) => [...prev, ...validFiles]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []));
    // Reset so re-selecting the same file fires onChange again.
    if (e.target.value) e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // dragleave fires for every child node — only flip off when the cursor
    // leaves the zone itself.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (uploading) return;
    addFiles(Array.from(e.dataTransfer.files || []));
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    setUploading(true);
    let successCount = 0;
    let failedCount = 0;

    for (const file of files) {
      const formData = new FormData();
      formData.append('photos', file);
      if (categoryId) {
        formData.append('category_id', categoryId.toString());
      }

      try {
        await api.post(`/gallery/${eventId}/upload`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: progress,
              }));
              if (progress >= 100) {
                setProcessingFiles(prev => ({ ...prev, [file.name]: true }));
              }
            }
          },
        });
        // Request resolved → file fully processed by backend.
        setProcessingFiles(prev => {
          const next = { ...prev };
          delete next[file.name];
          return next;
        });
        successCount++;
      } catch (error: any) {
        // Upload error handled - user notified via UI
        failedCount++;
        
        // Show specific error message
        const errorMessage = error.response?.data?.error || error.message || 'Upload failed';
        toast.error(`${file.name}: ${errorMessage}`);
      }
    }

    setUploading(false);

    if (successCount > 0) {
      toast.success(t('toast.uploadSuccess') + ` (${successCount} ${t('common.photos')})`);
      onUploadComplete();
    }
    
    if (failedCount > 0) {
      toast.error(`${failedCount} ${t('upload.someFilesFailed')}`);
    }

    if (failedCount === 0) {
      onClose();
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="w-full sm:max-w-2xl bg-surface flex flex-col max-h-[100vh] sm:max-h-[90vh] rounded-2xl shadow-xl overflow-hidden">
        {/* Fixed Header */}
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-surface flex-shrink-0">
          <h2 className="text-lg sm:text-xl font-semibold text-theme">{t('upload.uploadPhotos')}</h2>
          <button
            onClick={onClose}
            className="p-1.5 sm:p-2 hover:bg-black/10 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-muted-theme" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 p-4 sm:p-6 overflow-y-auto min-h-0">
            {/* Upload Area — accepts both click-to-pick and drag-and-drop (#504). */}
            <div className="mb-4 sm:mb-6">
              <label className="block">
                <div
                  className={`border-2 border-dashed rounded-lg p-6 sm:p-8 text-center hover:border-accent-dark transition-colors cursor-pointer ${
                    isDragOver ? 'border-accent-dark bg-accent-dark/10' : 'border-surface'
                  }`}
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <Upload className="w-10 h-10 sm:w-12 sm:h-12 text-neutral-400 mx-auto mb-3" />
                  <p className="text-sm font-medium text-muted-theme mb-1">
                    {t('upload.clickToUpload')}
                  </p>
                  <p className="text-xs text-muted-theme">
                    {/* #613 — pass { limit } so `{{limit}}` interpolates
                        with the real number from settings instead of
                        rendering literally. */}
                    {t('upload.fileRequirements', { limit: maxFilesPerUpload })}
                  </p>
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    accept={acceptString}
                    onChange={handleFileSelect}
                    disabled={uploading}
                  />
                </div>
              </label>
            </div>

            {/* Selected Files */}
            {files.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-theme mb-2">
                  {t('upload.selectedFiles')} ({files.length})
                </h3>
                {files.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-3 bg-surface rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-theme truncate">
                        {file.name}
                      </p>
                      <p className="text-xs text-muted-theme">
                        {formatBytes(file.size)}
                      </p>
                    </div>
                    {uploadProgress[file.name] !== undefined ? (
                      <div className="flex items-center gap-2">
                        {processingFiles[file.name] ? (
                          // Bytes are on the server; the request hasn't
                          // resolved yet because the backend is still
                          // generating thumbnails / reading EXIF. Show
                          // a spinner so it doesn't look stuck at 100%.
                          <Loader2 className="w-5 h-5 text-amber-600 animate-spin" />
                        ) : uploadProgress[file.name] === 100 ? (
                          <CheckCircle className="w-5 h-5 text-green-600" />
                        ) : (
                          <div className="w-20">
                            <div className="bg-neutral-200 rounded-full h-2">
                              <div
                                className="bg-accent-dark h-2 rounded-full transition-all"
                                style={{ width: `${uploadProgress[file.name]}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => removeFile(index)}
                        className="p-1 hover:bg-black/10 rounded transition-colors"
                        disabled={uploading}
                      >
                        <X className="w-4 h-4 text-muted-theme" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
        </div>

        {/* Fixed Footer */}
        <div className="flex items-center justify-end gap-2 sm:gap-3 p-4 sm:p-6 border-t border-surface bg-surface flex-shrink-0">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={uploading}
            className="text-sm sm:text-base"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleUpload}
            disabled={files.length === 0 || uploading}
            isLoading={uploading}
            className="text-sm sm:text-base"
          >
            {uploading ? t('upload.uploading') : t('common.upload')} ({files.length})
          </Button>
        </div>
      </div>
    </div>
  );
};

UserPhotoUpload.displayName = 'UserPhotoUpload';