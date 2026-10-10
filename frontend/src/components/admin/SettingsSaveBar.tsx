import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Save } from 'lucide-react';
import { Button } from '../common';
import { useUnsavedChanges } from '../../contexts/UnsavedChangesContext';
import { useBottomBarSlot } from './bottomBarSlot';

interface SettingsSaveBarProps {
  /** Draft differs from what the server has. Drives the hint and both buttons. */
  isDirty: boolean;
  isSaving?: boolean;
  onSave: () => void;
  /** Put the draft back to the server state. Also what the leave guard runs. */
  onDiscard: () => void;
  /** Extra gate for Save, e.g. a validation error in the form. Default true. */
  canSave?: boolean;
  /**
   * Offer Save with a clean draft as well, when saving does something the
   * comparison cannot see: a fallback template saved unchanged becomes the
   * event type's own copy. The hint, Discard and the leave guard still
   * follow `isDirty`.
   */
  saveClean?: boolean;
  /** Override the default "Save changes" label. */
  saveLabel?: string;
  /** Optional element on the left, e.g. a "test connection" button. */
  extra?: React.ReactNode;
}

/**
 * The one save control for settings forms (discussion 1541, point 3).
 *
 * Rendered into AdminLayout's bottom bar slot, so it sits at the bottom of
 * the window on every page — also on a page shorter than the window, where
 * a bar sticky inside the content would float under the last field. Outside
 * the layout (tests) it renders in place. It has the height of the
 * sidebar's collapse row (py-2 around h-9 buttons) so the two bottom edges
 * line up. Save and Discard are disabled while the draft equals the
 * server state, and the "unsaved changes" hint appears as soon as it does
 * not. Rendering it also registers the form with UnsavedChangesProvider, so
 * closing the tab or navigating away asks first. Instant-save toggles (a
 * switch that writes on change) do not belong behind this bar.
 */
export const SettingsSaveBar: React.FC<SettingsSaveBarProps> = ({
  isDirty,
  isSaving = false,
  onSave,
  onDiscard,
  canSave = true,
  saveClean = false,
  saveLabel,
  extra,
}) => {
  const { t } = useTranslation();
  useUnsavedChanges(isDirty, onDiscard);
  const slot = useBottomBarSlot();

  const bar = (
    <div
      data-testid="settings-save-bar"
      className={`${slot ? '' : 'sticky bottom-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 mt-8 '}px-4 sm:px-6 lg:px-8 py-2 bg-shell border-t border-line`}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {isDirty && (
          <span
            role="status"
            className="mr-auto text-xs text-warning-text flex items-center gap-1.5"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            {t('settings.saveBar.unsaved', 'You have unsaved changes')}
          </span>
        )}
        {extra}
        <Button variant="outline" size="sm" disabled={!isDirty || isSaving} onClick={onDiscard}>
          {t('common.discard', 'Discard')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={(!isDirty && !saveClean) || isSaving || !canSave}
          isLoading={isSaving}
          onClick={onSave}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {saveLabel ?? t('common.saveChanges', 'Save changes')}
        </Button>
      </div>
    </div>
  );

  return slot ? createPortal(bar, slot) : bar;
};

SettingsSaveBar.displayName = 'SettingsSaveBar';
