import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GuestNameMode } from '../../types';

interface UploaderNameSettingsProps {
  mode: GuestNameMode;
  onModeChange: (mode: GuestNameMode) => void;
  showToGuests: boolean;
  onShowToGuestsChange: (show: boolean) => void;
  // Prefix for the input ids, so two instances on one page stay unique.
  idPrefix?: string;
  className?: string;
}

const MODES: GuestNameMode[] = ['off', 'optional', 'required'];

/**
 * Uploader names (#1561): whether the guest upload dialog asks for a name,
 * and whether guests see the names. Used on the event form, the create form
 * and Settings → Event Defaults.
 */
export const UploaderNameSettings: React.FC<UploaderNameSettingsProps> = ({
  mode,
  onModeChange,
  showToGuests,
  onShowToGuestsChange,
  idPrefix = 'uploader-names',
  className = '',
}) => {
  const { t } = useTranslation();
  return (
    <div className={className}>
      <label htmlFor={`${idPrefix}-mode`} className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
        {t('events.uploaderNames.label')}
      </label>
      <select
        id={`${idPrefix}-mode`}
        value={mode}
        onChange={(e) => onModeChange(e.target.value as GuestNameMode)}
        className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
      >
        {MODES.map((value) => (
          <option key={value} value={value}>{t(`events.uploaderNames.modes.${value}`)}</option>
        ))}
      </select>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
        {t('events.uploaderNames.help')}
      </p>

      {/* Always offered: it also covers credits read from EXIF, which exist
          whatever the upload dialog asks. */}
      <div className="mt-3">
        <label className="flex items-center">
          <input
            id={`${idPrefix}-show`}
            type="checkbox"
            checked={showToGuests}
            onChange={(e) => onShowToGuestsChange(e.target.checked)}
            className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
          />
          <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">
            {t('events.uploaderNames.showToGuests')}
          </span>
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 ml-6">
          {t('events.uploaderNames.showToGuestsHelp')}
        </p>
      </div>
    </div>
  );
};

UploaderNameSettings.displayName = 'UploaderNameSettings';
