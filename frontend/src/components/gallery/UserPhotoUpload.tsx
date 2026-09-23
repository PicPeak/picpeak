import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Upload, X, CheckCircle, Loader2, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Button, Input } from '../common';
import { api } from '../../config/api';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { extensionsToMimeTypes, buildUploadAcceptString, extensionsToLabel, normalizeFileMimeType } from '../../utils/fileTypes';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { guestsService, type GuestIdentity } from '../../services/guests.service';
import { clearGuestIdentity, getGuestIdentity, getGuestToken, storeGuestIdentity } from '../../utils/guestIdentityStorage';
import type { GuestNameMode } from '../../types';

interface UserPhotoUploadProps {
  eventId: number;
  categoryId: number | null | undefined;
  // Receives the upload-group ids the backend queued the files under, so the
  // caller can poll their processing status instead of guessing (B7).
  onUploadComplete: (uploadIds: string[]) => void;
  onClose: () => void;
  // Uploader names (#1561). The name is the gallery's guest identity — the
  // same one likes and comments use — so it is keyed by slug and remembered on
  // this device. Without a slug, or with the mode off, there is no name step.
  slug?: string;
  nameMode?: GuestNameMode;
  // Whether other guests will see the name; only changes the privacy notice.
  creditsVisible?: boolean;
  // The feedback setting "require name and email" applies to the one guest
  // identity, so registering it from here has to ask for the address too.
  requireEmail?: boolean;
}

// Signing an established identity out re-keys everything under the
// GuestIdentityProvider, this dialog included, so its state would be lost.
// What must survive that remount is parked here, per gallery, and picked up
// by the next mount.
const carriedOver = new Map<string, { files: File[]; nameError?: string; uploadIds: string[] }>();

export const UserPhotoUpload: React.FC<UserPhotoUploadProps> = ({
  eventId,
  categoryId,
  onUploadComplete,
  onClose,
  slug,
  nameMode = 'off',
  creditsVisible = false,
  requireEmail = false,
}) => {
  const { t } = useTranslation();
  const identityContext = useGuestIdentityOptional();
  const askName = nameMode !== 'off' && !!slug;
  const [identity, setIdentity] = useState<GuestIdentity | null>(() => (askName ? getGuestIdentity(slug) : null));
  const [carried] = useState(() => {
    const state = slug ? carriedOver.get(slug) : undefined;
    if (slug) carriedOver.delete(slug);
    return state;
  });
  const [nameInput, setNameInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(carried?.nameError);
  const [emailError, setEmailError] = useState<string | undefined>();

  // The gallery may switch identity underneath the dialog (another tab,
  // "Not you?" in the feedback UI, an invite link). Follow it.
  useEffect(() => {
    if (identityContext && identityContext.slug === slug) {
      setIdentity(identityContext.identity);
    }
  }, [identityContext, identityContext?.identity, slug]);
  // Outside the provider (the pre-reveal upload view) nothing else follows
  // another tab signing in or out, so listen for it here.
  useEffect(() => {
    if (!askName || !slug || (identityContext && identityContext.slug === slug)) return undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== `guest_token_${slug}` && event.key !== `guest_identity_${slug}`) return;
      setIdentity(getGuestIdentity(slug));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [askName, slug, identityContext]);
  const [files, setFiles] = useState<File[]>(() => carried?.files ?? []);
  const [uploading, setUploading] = useState(false);
  const submittingRef = useRef(false);
  // Upload groups already queued by an attempt that stopped to ask for the
  // name again; handed to onUploadComplete with the attempt that finishes.
  const pendingUploadIdsRef = useRef<string[]>(carried?.uploadIds ?? []);
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

  // Per-file size limit (MB). Was hardcoded to 50MB below, so the admin's
  // "Max File Size" setting never applied to guests (#613 follow-up). Surfaced
  // via publicSettings (default 50); the backend enforces the same value.
  const maxFileSizeMb = Number.isFinite(Number(publicSettings?.general_max_file_size_mb))
    ? Number(publicSettings?.general_max_file_size_mb)
    : 50;
  const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;

  const allowedMimeTypes = useMemo(
    () => extensionsToMimeTypes(publicSettings?.allowed_file_types),
    [publicSettings?.allowed_file_types]
  );

  // #1117 — on Android this appends a type the photo picker can't handle, so
  // the system falls back to the chooser that actually offers the camera.
  const acceptString = useMemo(
    () => buildUploadAcceptString(publicSettings?.allowed_file_types),
    [publicSettings?.allowed_file_types]
  );

  // #821 — the requirements hint used to hardcode "JPEG, PNG or WebP"; render
  // the actually-configured formats so it never contradicts what's accepted.
  const formatsLabel = useMemo(
    () => extensionsToLabel(publicSettings?.allowed_file_types),
    [publicSettings?.allowed_file_types]
  );

  // Shared filter pipeline for both <input> change and drag-and-drop (#504).
  const addFiles = (incoming: File[]) => {
    const validFiles = incoming.filter((file) => {
      if (!allowedMimeTypes.includes(normalizeFileMimeType(file.name, file.type))) {
        toast.error(`Invalid file type: ${file.name}`);
        return false;
      }
      // Check file size against the configured per-file limit.
      if (file.size > maxFileSizeBytes) {
        toast.error(t('upload.fileTooLarge', { name: file.name, limit: maxFileSizeMb }));
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

  // Resolve who is uploading, registering the typed name as a guest identity
  // when there is none yet. Returns false when the upload must not start.
  const resolveUploader = async (): Promise<{ ok: boolean; token: string | null }> => {
    if (!askName || !slug) return { ok: true, token: null };
    if (identity) {
      // The token sent is whatever this device holds now; if that is no
      // longer the guest the dialog shows, show the current one and let the
      // guest confirm with another click rather than credit someone else.
      const stored = getGuestIdentity(slug);
      if (!stored || stored.id !== identity.id) {
        setIdentity(stored);
        return { ok: false, token: null };
      }
      return { ok: true, token: getGuestToken(slug) };
    }

    const name = nameInput.trim();
    if (!name) {
      if (nameMode === 'required') {
        setNameError(t('upload.nameRequired'));
        return { ok: false, token: null };
      }
      return { ok: true, token: null };
    }
    const email = emailInput.trim();
    if (requireEmail && !email) {
      setEmailError(t('gallery.guestPrompt.emailRequired', 'Email is required'));
      return { ok: false, token: null };
    }

    try {
      let registered: GuestIdentity;
      if (identityContext && identityContext.slug === slug) {
        registered = await identityContext.register(name, email || undefined);
      } else {
        const response = await guestsService.registerGuest(slug, { name, email: email || undefined });
        storeGuestIdentity(slug, response.guest, response.token);
        registered = response.guest;
      }
      setIdentity(registered);
      return { ok: true, token: getGuestToken(slug) };
    } catch (error: any) {
      const data = error?.response?.data;
      if (data?.field === 'email') {
        setEmailError(data.error);
      } else {
        setNameError(data?.error || t('upload.nameSaveFailed'));
      }
      return { ok: false, token: null };
    }
  };

  // "Not you?": drop the identity on this device only. The guest row and its
  // feedback stay; this is the shared-phone case, not "forget me".
  const handleNotYou = (nameErrorAfter?: string, keepFiles: File[] = files, uploadIds: string[] = []) => {
    if (!slug) return;
    if (identityContext && identityContext.slug === slug) {
      // Only a switch away from an established identity remounts the dialog.
      if (identityContext.identity) {
        carriedOver.set(slug, {
          files: keepFiles,
          nameError: nameErrorAfter,
          uploadIds: [...pendingUploadIdsRef.current, ...uploadIds],
        });
      }
      identityContext.signOut();
    } else {
      clearGuestIdentity(slug);
    }
    setIdentity(null);
    setNameError(nameErrorAfter);
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    // Claimed before registering: a second click while the name is being
    // saved would register another guest and send the whole batch twice. A
    // ref, because both clicks can land before `uploading` re-renders.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setNameError(undefined);
    setEmailError(undefined);
    setUploading(true);
    const uploader = await resolveUploader();
    if (!uploader.ok) {
      submittingRef.current = false;
      setUploading(false);
      return;
    }

    let successCount = 0;
    let failedCount = 0;
    // The 202 hands back the id of the upload group the files were queued
    // under. One request per file means one id per file; the gallery polls
    // them together to know when the background worker is done (B7).
    const uploadIds: string[] = [];
    // Set when the photo limit stopped the batch; its own message already
    // explains every file that was not sent.
    let stoppedAtPhotoCap = false;
    // Set when the server no longer knows the stored uploader; the name field
    // is back on screen and says why.
    let stoppedForName = false;

    for (const [index, file] of files.entries()) {
      // The gallery's photo limit refuses this file and every one after it:
      // one message, and no requests that can only be refused.
      const stopAtPhotoCap = (limit?: number) => {
        stoppedAtPhotoCap = true;
        failedCount += files.length - index;
        toast.error(t('upload.photoCapReached', { limit }));
      };
      const formData = new FormData();
      formData.append('photos', file);
      if (categoryId) {
        formData.append('category_id', categoryId.toString());
      }

      try {
        const response = await api.post<{
          upload_id?: string;
          count?: number;
          errors?: Array<{ filename?: string; error?: string; code?: string; limit?: number }>;
        }>(`/gallery/${eventId}/upload`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
            // Explicit, not left to the interceptor: this URL carries the
            // event id where the interceptor looks for a slug, so it would
            // look the guest token up under the wrong key (#1561).
            ...(uploader.token ? { 'x-guest-token': uploader.token } : {}),
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
        setProcessingFiles(prev => {
          const next = { ...prev };
          delete next[file.name];
          return next;
        });

        // A 202 does NOT mean the file landed: the route still answers 202
        // with `count: 0` and an `errors[]` entry when the queue refuses it
        // (content/type mismatch, cap hit). Counting that as a success fired
        // "Upload completed successfully" for a photo that never existed —
        // the guest-side twin of QA P4-B.05 / 7.05.
        const queuedCount = response.data?.count;
        if (typeof queuedCount === 'number' && queuedCount === 0) {
          const firstError = response.data?.errors?.[0];
          if (firstError?.code === 'PHOTO_CAP_REACHED') {
            stopAtPhotoCap(firstError.limit);
            break;
          }
          failedCount++;
          const reason = firstError?.error || t('upload.someFilesFailed');
          toast.error(`${file.name}: ${reason}`);
          continue;
        }

        // Bytes are stored and queued. Processing continues in the background
        // worker; `upload_id` is how the gallery follows it.
        if (response.data?.upload_id) {
          uploadIds.push(response.data.upload_id);
        }
        successCount++;
      } catch (error: any) {
        if (error.response?.data?.code === 'PHOTO_CAP_REACHED') {
          stopAtPhotoCap(error.response.data.limit);
          break;
        }
        // The stored identity is no longer honoured (removed by the host,
        // expired): ask for the name again instead of failing every file.
        if (error.response?.data?.code === 'UPLOADER_NAME_REQUIRED') {
          failedCount += files.length - index;
          stoppedForName = true;
          // The files before this one went through; keep only the rest.
          const unsent = files.slice(index);
          handleNotYou(t('upload.nameRequired'), unsent, uploadIds);
          setFiles(unsent);
          break;
        }
        // Upload error handled - user notified via UI
        failedCount++;
        
        // Show specific error message
        const errorMessage = error.response?.data?.error || error.message || 'Upload failed';
        toast.error(`${file.name}: ${errorMessage}`);
      }
    }

    submittingRef.current = false;
    setUploading(false);

    if (successCount > 0) {
      toast.success(t('toast.uploadSuccess') + ` (${successCount} ${t('common.photos')})`);
    }
    if (stoppedForName) {
      // onUploadComplete closes the dialog, and the guest has a name to enter
      // and files left to send. Report these groups with the next attempt.
      pendingUploadIdsRef.current = [...pendingUploadIdsRef.current, ...uploadIds];
    } else if (successCount > 0 || pendingUploadIdsRef.current.length > 0) {
      onUploadComplete([...pendingUploadIdsRef.current, ...uploadIds]);
      pendingUploadIdsRef.current = [];
    }
    
    if (failedCount > 0 && !stoppedAtPhotoCap && !stoppedForName) {
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
            {/* Uploader name (#1561) */}
            {askName && (
              <div className="mb-4 sm:mb-6 rounded-lg border border-surface p-3 sm:p-4" data-testid="uploader-name-step">
                {identity ? (
                  <div className="flex items-center justify-between gap-3">
                    <p className="flex items-center gap-2 text-sm text-theme min-w-0">
                      <UserRound className="w-4 h-4 flex-shrink-0 text-muted-theme" aria-hidden="true" />
                      <span className="truncate">{t('upload.uploadingAs', { name: identity.name })}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => handleNotYou()}
                      disabled={uploading}
                      className="text-xs font-medium text-accent hover:underline flex-shrink-0"
                    >
                      {t('upload.notYou')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Input
                      themed
                      label={nameMode === 'required' ? t('upload.yourName') : t('upload.yourNameOptional')}
                      value={nameInput}
                      onChange={(e) => { setNameInput(e.target.value); setNameError(undefined); }}
                      error={nameError}
                      placeholder={t('gallery.guestPrompt.namePlaceholder', 'Enter your name')}
                      autoComplete="name"
                      maxLength={100}
                      required={nameMode === 'required'}
                      disabled={uploading}
                    />
                    {requireEmail && (
                      <Input
                        themed
                        type="email"
                        label={t('gallery.guestPrompt.emailLabelRequired', 'Email')}
                        value={emailInput}
                        onChange={(e) => { setEmailInput(e.target.value); setEmailError(undefined); }}
                        error={emailError}
                        placeholder={t('gallery.guestPrompt.emailPlaceholder', 'you@example.com')}
                        autoComplete="email"
                        maxLength={255}
                        disabled={uploading}
                      />
                    )}
                  </div>
                )}
                {identity && nameError && (
                  <p className="mt-2 text-xs text-red-600">{nameError}</p>
                )}
                <p className="mt-2 text-xs text-muted-theme">
                  {creditsVisible ? t('upload.namePrivacyShown') : t('upload.namePrivacyHidden')}
                </p>
              </div>
            )}

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
                    {t('upload.fileRequirements', { formats: formatsLabel, limit: maxFilesPerUpload, sizeLimit: maxFileSizeMb })}
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
            disabled={files.length === 0 || uploading || (askName && nameMode === 'required' && !identity && !nameInput.trim())}
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