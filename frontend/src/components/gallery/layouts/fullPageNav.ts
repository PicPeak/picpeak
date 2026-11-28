import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { selectLabel } from '../../../utils/mediaCounts';

interface FullPageLabelOptions {
  isClient?: boolean;
  hasVideos?: boolean;
  isSelectionMode?: boolean;
  copyFilenamesCount?: number;
}

/** The names the full-page layouts give the gallery's actions in their own nav. */
export function useFullPageLabels({
  isClient = false,
  hasVideos = false,
  isSelectionMode = false,
  copyFilenamesCount = 0,
}: FullPageLabelOptions = {}) {
  const { t } = useTranslation();
  return {
    upload: t('upload.uploadPhotos', 'Upload Photos'),
    downloadAll: t('common.downloadAll', 'Download All'),
    manage: isClient ? t('clientAccess.returnToGallery', 'Return to gallery') : t('clientAccess.manageGallery', 'Manage Gallery'),
    /** The selection toggle: what a click on it does now. */
    select: isSelectionMode ? t('gallery.cancelSelection', 'Cancel Selection') : selectLabel(t, hasVideos),
    copyFilenames: `${t('gallery.copyFilenames.button', 'Copy filenames')} (${copyFilenamesCount})`,
  };
}

interface SelectionControlOptions {
  /** The photos the layout shows, in its order: what "select all" covers. */
  visiblePhotos: ReadonlyArray<{ id: number }>;
  selected: ReadonlySet<number>;
  isSelectionMode: boolean;
  onDeselectAll?: () => void;
  onToggleSelectionMode?: () => void;
  onSelectMany?: (photoIds: number[]) => void;
}

/**
 * The selection controls a full-page layout draws in its own nav (issue
 * 1716). The container owns the mode and the set; the layout only asks.
 */
export function useSelectionControls({
  visiblePhotos,
  selected,
  isSelectionMode,
  onDeselectAll,
  onToggleSelectionMode,
  onSelectMany,
}: SelectionControlOptions) {
  const allVisibleSelected = visiblePhotos.length > 0 && visiblePhotos.every((photo) => selected.has(photo.id));

  const toggleSelectionMode = useCallback(() => {
    // Leaving selection mode clears the selection, so a later session does
    // not start with invisible ticks.
    if (isSelectionMode) onDeselectAll?.();
    onToggleSelectionMode?.();
  }, [isSelectionMode, onDeselectAll, onToggleSelectionMode]);

  const selectAllVisible = useCallback(() => {
    if (allVisibleSelected) onDeselectAll?.();
    else onSelectMany?.(visiblePhotos.map((photo) => photo.id));
  }, [allVisibleSelected, onDeselectAll, onSelectMany, visiblePhotos]);

  return { allVisibleSelected, toggleSelectionMode, selectAllVisible };
}
