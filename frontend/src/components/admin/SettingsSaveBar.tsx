import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Save } from 'lucide-react';
import { Button } from '../common';
import { useUnsavedChanges } from '../../contexts/UnsavedChangesContext';

interface SettingsSaveBarProps {
  /** Draft differs from what the server has. Drives the hint and both buttons. */
  isDirty: boolean;
  isSaving?: boolean;
  onSave: () => void;
  /** Put the draft back to the server state. Also what the leave guard runs. */
  onDiscard: () => void;
  /** Extra gate for Save, e.g. a validation error in the form. Default true. */
  canSave?: boolean;
  /** Override the default "Save changes" label. */
  saveLabel?: string;
  /** Optional element on the left, e.g. a "test connection" button. */
  extra?: React.ReactNode;
}

/**
 * The one save control for settings forms (discussion 1541, point 3).
 *
 * Sticks to the bottom of the admin content so it sits in the same place
 * on every tab; Save and Discard are disabled while the draft equals the
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
  saveLabel,
  extra,
}) => {
  const { t } = useTranslation();
  useUnsavedChanges(isDirty, onDiscard);

  return (
    <div
      data-testid="settings-save-bar"
      className="sticky bottom-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 mt-8 px-4 sm:px-6 lg:px-8 py-3 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-t border-neutral-200 dark:border-neutral-700"
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {isDirty && (
          <span
            role="status"
            className="mr-auto text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            {t('settings.saveBar.unsaved', 'You have unsaved changes')}
          </span>
        )}
        {extra}
        <Button variant="outline" disabled={!isDirty || isSaving} onClick={onDiscard}>
          {t('common.discard', 'Discard')}
        </Button>
        <Button
          variant="primary"
          disabled={!isDirty || isSaving || !canSave}
          isLoading={isSaving}
          onClick={onSave}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {saveLabel ?? t('common.saveChanges', 'Save changes')}
        </Button>
      </div>
    </div>
  );
};

SettingsSaveBar.displayName = 'SettingsSaveBar';
