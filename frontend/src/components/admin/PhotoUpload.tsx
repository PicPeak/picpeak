import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Upload, X, Image, FolderUp, FilePlus } from 'lucide-react';
import { Button, Notice } from '../common';
import { clsx } from 'clsx';
import { toast } from 'react-toastify';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { categoriesService } from '../../services/categories.service';
import { folderQueryKey, foldersService, MAX_RESOLVE_PATHS } from '../../services/folders.service';
import { settingsService } from '../../services/settings.service';
import { useTranslation } from 'react-i18next';
import { extensionsToMimeTypes, extensionsToAcceptString, extensionsToLabel, isAllowedUploadFile } from '../../utils/fileTypes';
import { useUploadSession, type UploadBatch } from '../../contexts/UploadSessionContext';
import { collectDroppedEntries, pickedFromInput, type PickedFile } from '../../utils/droppedFiles';
import { buildUploadPreview, groupFilesByPlacement, hasDirectories, uniqueDirectories } from '../../utils/uploadStructure';
import { childFolders, folderPathLabel } from '../../utils/folderTree';
import { UploadStructurePreview } from './UploadStructurePreview';

interface PhotoUploadProps {
  eventId: number;
  /** Fired the moment the upload is handed to the session. The host (modal)
   *  closes on it; progress and the failure report live in UploadProgressBar. */
  onUploadStarted?: () => void;
  /** The event's folder_structure setting: the default of "Keep folder structure" (issue 1786). */
  folderStructureDefault?: boolean;
  /** Folder loose files go to at first (the folder open on the Photos tab); null = root. */
  defaultFolderId?: number | null;
}

// Wait this long after the last change before asking the server for the
// structure preview, so a folder walk landing in pieces asks once.
const PREVIEW_DEBOUNCE_MS = 300;

const DEFAULT_MAX_FILES_PER_UPLOAD = 500;
// Largest value general_max_files_per_upload can take; mirrors
// MAX_ALLOWED_FILES_PER_UPLOAD in backend/src/services/uploadSettings.js.
const MAX_FILES_PER_UPLOAD_LIMIT = 2000;
// How many admissible files a folder walk collects at most. Fixed, not the
// capacity at drop time: the cap can be raised and files can be removed
// while a walk is pending, and addFiles applies the live cap when it lands.
// One above the largest possible cap, so its "some files skipped" notice
// still fires for a tree that exceeds even that.
const FOLDER_WALK_CEILING = MAX_FILES_PER_UPLOAD_LIMIT + 1;

export const PhotoUpload: React.FC<PhotoUploadProps> = ({
  eventId,
  onUploadStarted,
  folderStructureDefault = false,
  defaultFolderId = null,
}) => {
  const { t } = useTranslation();
  const { startUpload, isUploading } = useUploadSession();
  // Each file with its directory relative to the drop or folder pick (issue
  // 1786); '' for loose files.
  const [selectedFiles, setSelectedFiles] = useState<PickedFile[]>([]);
  // Folder walks still resolving. Upload stays disabled while any is pending:
  // otherwise a click sends the current selection, clears it, and the walk's
  // files arrive in a modal that has already unmounted.
  const [pendingWalks, setPendingWalks] = useState(0);
  // The selection as of the last add/remove, written synchronously. A folder
  // walk resolves asynchronously, so `addFiles` may run from a render that
  // predates another drop or pick; reading the cap against `selectedFiles`
  // from that render let two concurrent additions exceed maxFilesPerUpload.
  const selectedFilesRef = useRef<PickedFile[]>([]);
  const commitSelection = (next: PickedFile[]) => {
    selectedFilesRef.current = next;
    setSelectedFiles(next);
  };
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [replaceByName, setReplaceByName] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Folder uploads (issue 1786).
  const [keepStructure, setKeepStructure] = useState(folderStructureDefault);
  // Only applies when the dry run reports a single outer folder; checked by
  // default there, as the mockup asks.
  const [skipOuter, setSkipOuter] = useState(true);
  const [looseFolderId, setLooseFolderId] = useState<number | null>(defaultFolderId);
  // The real (not dry-run) resolve call between the click and the upload.
  const [resolving, setResolving] = useState(false);

  // React has no typed prop for webkitdirectory, so it is set on the node.
  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  // Fetch categories for this event
  const { data: categories = [] } = useQuery({
    queryKey: ['event-categories', eventId],
    queryFn: () => categoriesService.getEventCategories(eventId),
  });

  // Folders for the "Upload into" select. Upload-only roles can read them
  // too (photos.view); the select is hidden while there are none.
  const { data: folderTree } = useQuery({
    queryKey: folderQueryKey(eventId),
    queryFn: () => foldersService.list(eventId),
  });
  const folders = folderTree?.folders ?? [];
  // Depth-first, so the select reads like the tree.
  const folderOptions = useMemo(() => {
    const list = folderTree?.folders ?? [];
    const out: Array<{ id: number; label: string; depth: number }> = [];
    const walk = (parentId: number | null, depth: number) => {
      for (const f of childFolders(list, parentId)) {
        out.push({ id: f.id, label: f.name, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folderTree]);
  // Folders are no categories any more (issue 1786): only filter categories
  // are offered as the upload's category.
  const filterCategories = useMemo(() => categories.filter((c) => !c.is_folder), [categories]);

  const { data: settings, isPending: settingsPending } = useQuery({
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
  // One admission rule for picked and dropped files: allowed type, and the
  // pre-flight size check mirroring the guest uploader (without it the admin
  // streams the whole oversized file before the backend 400s it). The folder
  // walk applies it too, so sidecars and oversized files do not use up the
  // per-upload budget before the photos behind them are reached.
  const admitFile = (file: File, rejected?: string[]): boolean => {
    // Matches on the extension when the browser reports no type, which is
    // what it does for camera RAW on macOS and Windows. A rejection is
    // silent and its name goes on `rejected` if the caller passed a list,
    // because a file chosen by hand is worth naming and a sidecar found
    // inside a dropped folder is not.
    if (!isAllowedUploadFile(file, allowedMimeTypes)) {
      rejected?.push(file.name);
      return false;
    }
    const limitMb = sizeLimitMbFor(file);
    if (file.size > limitMb * 1024 * 1024) {
      toast.error(t('upload.fileTooLarge', { name: file.name, limit: limitMb }));
      return false;
    }
    return true;
  };

  // Picking or dropping a file of the wrong type used to produce nothing at
  // all: no toast, no log, no request. The zone simply did not react, which
  // reads as a broken page rather than a rejected format.
  const reportRejectedTypes = (rejected: string[]) => {
    if (rejected.length === 0) return;
    toast.error(t('upload.invalidFileType', { names: rejected.join(', ') }));
  };

  const addFiles = (incoming: PickedFile[]) => {
    // Only loose files (chosen or dropped by hand, dir '') are named when
    // rejected: a picked folder of RAW plus XMP sidecars would otherwise put
    // every sidecar in one toast. The folder input has no `accept` to
    // prefilter it.
    const rejected: string[] = [];
    const imageFiles = incoming.filter((picked) => admitFile(picked.file, picked.dir === '' ? rejected : undefined));
    reportRejectedTypes(rejected);
    if (imageFiles.length === 0) return;

    const current = selectedFilesRef.current;
    const totalFiles = current.length + imageFiles.length;
    if (totalFiles > maxFilesPerUpload) {
      const allowedNewFiles = maxFilesPerUpload - current.length;
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
      commitSelection([...current, ...imageFiles.slice(0, allowedNewFiles)]);
      return;
    }

    commitSelection([...current, ...imageFiles]);
  };

  // A folder walk settles in a later render; it must validate with the
  // limits of that render (admin-settings may have resolved or refreshed
  // meanwhile), not with the addFiles closure of the drop.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const admitFileRef = useRef(admitFile);
  admitFileRef.current = admitFile;
  // Whether the limits above come from the server yet. Until admin-settings
  // has resolved, admitFile judges by the defaults (no video, 50 MB), which
  // must not decide what a folder walk keeps.
  const settingsLoadedRef = useRef(false);
  settingsLoadedRef.current = settings !== undefined;
  // Dropped files are admitted only once admin-settings has settled (loaded
  // or failed): a walk that finishes earlier waits here, or addFiles would
  // discard a server-allowed video or larger photo under the defaults for
  // good. The walk stays counted in pendingWalks, so Upload is held too.
  const settingsSettledRef = useRef(false);
  settingsSettledRef.current = !settingsPending;
  const settledWaiters = useRef<Array<() => void>>([]);
  useEffect(() => {
    if (!settingsPending) settledWaiters.current.splice(0).forEach((resume) => resume());
  }, [settingsPending]);
  const whenSettingsSettled = () => (settingsSettledRef.current
    ? Promise.resolve()
    : new Promise<void>((resume) => { settledWaiters.current.push(resume); }));

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    // A folder pick carries webkitRelativePath; a plain pick does not.
    addFiles(pickedFromInput(Array.from(e.target.files || [])));
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
    // Dropped folders are walked recursively (issue 1733, C1); the result
    // goes through the same filter and per-upload cap as picked files.
    setPendingWalks((n) => n + 1);
    // The walk stops at a fixed ceiling instead of reading a whole archive;
    // the cap itself is applied by addFiles against the selection and the
    // settings as they are when the walk lands.
    // The prefilter only keeps sidecars and oversized files from using up
    // the ceiling, and only once the real limits are known: a file read
    // before admin-settings resolved is collected as it is and judged by
    // addFiles when the walk lands. A file it rejects is not collected, so
    // its size toast fires here or in addFiles, never in both.
    // Same for the wrong-type toast, which is why the names are gathered
    // here rather than inside the admission rule. Only the items dropped by
    // hand, depth 0: a folder of RAW next to its XMP sidecars would
    // otherwise name every sidecar in it.
    const rejected: string[] = [];
    const accept = (file: File, depth: number) => !settingsLoadedRef.current
      || admitFileRef.current(file, depth === 0 ? rejected : undefined);
    // The walk also stops after examining a multiple of the ceiling (a tree
    // of mostly unsupported files); say so rather than omit the rest silently.
    const onTruncated = () => toast.warning(t('upload.folderTooLarge'));
    void collectDroppedEntries(e.dataTransfer, { limit: FOLDER_WALK_CEILING, accept, onTruncated })
      .then(async (files) => {
        await whenSettingsSettled();
        reportRejectedTypes(rejected);
        addFilesRef.current(files);
      })
      .finally(() => setPendingWalks((n) => n - 1));
  };

  const removeFile = (index: number) => {
    commitSelection(selectedFilesRef.current.filter((_, i) => i !== index));
  };

  // --- Structure preview (issues 1786 + 1562) ---------------------------
  const withFolders = hasDirectories(selectedFiles);
  const directories = useMemo(() => uniqueDirectories(selectedFiles), [selectedFiles]);
  const directoriesKey = directories.join('\n');
  const [debouncedKey, setDebouncedKey] = useState(directoriesKey);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedKey(directoriesKey), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [directoriesKey]);
  const tooManyDirectories = directories.length > MAX_RESOLVE_PATHS;
  const previewQuery = useQuery({
    queryKey: ['folder-resolve-preview', eventId, debouncedKey, skipOuter, keepStructure],
    queryFn: () => foldersService.resolve(eventId, {
      paths: debouncedKey.split('\n'),
      skipOuter,
      keepStructure,
      dryRun: true,
    }),
    enabled: withFolders && !tooManyDirectories && debouncedKey === directoriesKey,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const resolved = withFolders ? previewQuery.data : undefined;
  const preview = useMemo(
    () => (resolved ? buildUploadPreview(selectedFiles, resolved, { skipOuter, keepStructure }) : null),
    [resolved, selectedFiles, skipOuter, keepStructure]
  );
  // Unknown until the folder list loads: assume the narrower role so an
  // upload-only admin never sees "create folders" wording first.
  const canManageFolders = resolved?.can_manage ?? folderTree?.can_manage ?? false;
  const looseTargetLabel = looseFolderId
    ? folderPathLabel(folders, looseFolderId) || t('upload.structure.galleryRoot', 'gallery root')
    : t('upload.structure.galleryRoot', 'gallery root');

  const uploadLabel = (() => {
    const count = selectedFiles.length;
    if (withFolders && preview && keepStructure && preview.folderCount > 0) {
      const requesting = !canManageFolders && preview.requestedFolders > 0;
      const folderText = t('upload.structure.folderCount', '{{count}} folders', {
        count: requesting ? preview.requestedFolders : preview.folderCount,
      });
      return requesting
        ? t('upload.structure.uploadRequesting', 'Upload {{count}} files · request {{folders}}', { count, folders: folderText })
        : t('upload.structure.uploadIntoFolders', 'Upload {{count}} files into {{folders}}', { count, folders: folderText });
    }
    return t('common.upload') + ` ${count} ${t(count === 1 ? 'common.photo' : 'common.photos')}`;
  })();

  const handleUpload = async () => {
    if (selectedFiles.length === 0 || isUploading || pendingWalks > 0 || resolving) return;

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

    // Files from folders: resolve their directories for real (creates the
    // folders, or opens folder requests for an upload-only role), then send
    // one batch per placement. Loose files keep the old single batch.
    // What this click sends. Files dropped while the folders below resolve
    // are not part of it: they stay selected for the next upload instead of
    // being cleared unsent (review of PR 1826, concern 14).
    const sending = selectedFilesRef.current;
    let batches: UploadBatch[] = [{
      files: sending.map((picked) => picked.file),
      placement: { categoryId: selectedCategoryId, folderId: looseFolderId },
    }];
    if (withFolders) {
      if (tooManyDirectories) {
        toast.error(t('upload.structure.tooManyFolders', 'This selection has more than {{limit}} folders. Upload it in parts.', { limit: MAX_RESOLVE_PATHS }));
        return;
      }
      setResolving(true);
      try {
        const result = await foldersService.resolve(eventId, {
          paths: directories,
          skipOuter,
          keepStructure,
          dryRun: false,
        });
        batches = groupFilesByPlacement(sending, result.results, {
          categoryId: selectedCategoryId,
          looseFolderId,
        }).groups;
      } catch (error: unknown) {
        const e = error as { response?: { data?: { error?: string } } };
        toast.error(e.response?.data?.error || t('upload.structure.resolveFailed', 'The folders for this upload could not be prepared. Nothing was uploaded.'));
        return;
      } finally {
        setResolving(false);
      }
    }

    batches = batches.filter((batch) => batch.files.length > 0);
    if (batches.length === 0) {
      // Everything sat in hidden or skipped folders: say so instead of
      // closing the dialog as if an upload had started.
      toast.warning(t('upload.structure.nothingToUpload', 'None of the selected files can be uploaded: they are all in hidden or skipped folders.'));
      return;
    }

    startUpload({
      eventId,
      batches,
      replaceByName,
      maxFilesPerChunk: Math.max(1, Math.min(50, maxFilesPerUpload)), // Max 50 files per chunk
      maxBytesPerChunk: maxBatchSizeMb * 1024 * 1024,
    });

    const sentSet = new Set(sending);
    const leftOver = selectedFilesRef.current.filter((picked) => !sentSet.has(picked));
    commitSelection(leftOver);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (folderInputRef.current) {
      folderInputRef.current.value = '';
    }
    if (leftOver.length > 0) {
      // Keep the dialog open with what arrived while preparing.
      toast.info(t('upload.structure.keptForNext', 'Files added while the folders were prepared are still selected: {{count}}.', { count: leftOver.length }));
      return;
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
        <Notice tone="neutral">
          {t('upload.alreadyRunning', 'An upload is already running. It has to finish before the next one can start.')}
        </Notice>
      )}

      {/* Target folder (issue 1786): where files without a folder of their
          own land. Shown once the event has folders. */}
      {folderOptions.length > 0 && (
        <div>
          <label htmlFor="upload-target-folder" className="block text-sm font-medium text-body mb-2">
            {withFolders
              ? t('upload.structure.looseFilesGoTo', 'Loose files go to')
              : t('upload.structure.uploadInto', 'Upload into')}
          </label>
          <select
            id="upload-target-folder"
            value={looseFolderId ?? ''}
            onChange={(e) => setLooseFolderId(e.target.value ? Number(e.target.value) : null)}
            className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:ring-2 focus:ring-accent"
          >
            <option value="">{t('photos.folders.galleryRoot', 'Gallery root')}</option>
            {folderOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {'\u00a0\u00a0'.repeat(option.depth + 1)}{option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Category Selection */}
      <div>
        <label className="block text-sm font-medium text-body mb-2">
          {t('upload.photoCategory')}
        </label>
        <select
          value={selectedCategoryId || ''}
          onChange={(e) => setSelectedCategoryId(e.target.value ? Number(e.target.value) : null)}
          className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:ring-2 focus:ring-accent"
        >
          <option value="">{t('upload.noCategory')}</option>
          {filterCategories.map((category) => (
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
          className="rounded border-line-strong text-accent focus:ring-accent"
        />
        <label htmlFor="replace-by-name" className="text-sm text-body">
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
              : "border-line-strong"
        )}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Upload className="w-12 h-12 mx-auto text-faint mb-4" />
        <p className="text-body font-medium mb-1">
          {t('upload.clickToUploadOrDropFolder')}
        </p>
        <p className="text-sm text-muted">
          {t('upload.fileRequirements', { formats: formatsLabel, limit: maxFilesPerUpload, sizeLimit: maxFileSizeMb })}
        </p>
        {videoUploadsAllowed && (
          <p className="text-sm text-muted">
            {t('upload.videoSizeLimit', 'Videos: max {{sizeLimit}}MB per file', { sizeLimit: maxVideoSizeMb })}
          </p>
        )}
        <p
          className={clsx(
            "text-xs mt-2",
            remainingSlots === 0 ? "text-danger-text" : "text-muted"
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
        {/* Folder pick (issue 1786): webkitdirectory is set in an effect. */}
        <input
          ref={folderInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          data-testid="folder-input"
        />
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          leftIcon={<FilePlus className="w-4 h-4" />}
        >
          {t('upload.addFiles', 'Add files')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => folderInputRef.current?.click()}
          leftIcon={<FolderUp className="w-4 h-4" />}
        >
          {t('upload.chooseFolder', 'Choose folder')}
        </Button>
      </div>

      {withFolders && (
        <UploadStructurePreview
          preview={preview}
          isLoading={previewQuery.isFetching}
          isError={previewQuery.isError || tooManyDirectories}
          keepStructure={keepStructure}
          onKeepStructureChange={setKeepStructure}
          singleRoot={resolved?.single_root ?? null}
          skipOuter={skipOuter}
          onSkipOuterChange={setSkipOuter}
          canManage={canManageFolders}
          maxDepth={resolved?.max_depth ?? folderTree?.max_depth ?? 3}
          looseTargetLabel={looseTargetLabel}
        />
      )}

      {/* Selected Files */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-body">
            {t('upload.selectedFiles')} ({selectedFiles.length})
          </p>
          <div className="max-h-48 overflow-y-auto space-y-2">
            {selectedFiles.map(({ file, dir }, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-2 bg-subtle rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <Image className="w-5 h-5 text-faint" />
                  <div>
                    <p className="text-sm font-medium text-body truncate max-w-xs">
                      {file.name}
                    </p>
                    {dir && <p className="text-xs text-muted truncate max-w-xs">{dir}/</p>}
                    <p className="text-xs text-muted">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(index);
                  }}
                  className="p-1 hover:bg-fill rounded"
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
          disabled={selectedFiles.length === 0 || isUploading || pendingWalks > 0 || resolving}
          isLoading={pendingWalks > 0 || resolving}
          leftIcon={<Upload className="w-4 h-4" />}
        >
          {uploadLabel}
        </Button>
      </div>
    </div>
  );
};

PhotoUpload.displayName = 'PhotoUpload';
