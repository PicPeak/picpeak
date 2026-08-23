import React from 'react';
import { Save, AlertCircle } from 'lucide-react';
import { Button, Card } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import type { EventSettings } from '../hooks/useSettingsState';
import { COLOR_LABEL_SWATCHES, COLOR_LABELS } from '../../../services/feedback.service';

interface EventsTabProps {
  eventSettings: EventSettings;
  setEventSettings: React.Dispatch<React.SetStateAction<EventSettings>>;
  saveEventSettingsMutation: {
    mutate: () => void;
    isPending: boolean;
  };
}

/**
 * The per-type feedback defaults, in the order the per-event panel shows
 * them. Mirrors FEEDBACK_TOGGLES in backend services/feedbackDefaults.js.
 */
const FEEDBACK_TYPE_DEFAULTS: Array<{
  key: 'event_default_allow_ratings' | 'event_default_allow_likes'
    | 'event_default_allow_favorites' | 'event_default_allow_comments'
    | 'event_default_allow_reactions' | 'event_default_allow_color_labels';
  label: string;
  fallback: string;
}> = [
  { key: 'event_default_allow_ratings', label: 'settings.events.defaultAllowRatings', fallback: 'Star ratings' },
  { key: 'event_default_allow_likes', label: 'settings.events.defaultAllowLikes', fallback: 'Likes' },
  { key: 'event_default_allow_favorites', label: 'settings.events.defaultAllowFavorites', fallback: 'Favourites' },
  { key: 'event_default_allow_comments', label: 'settings.events.defaultAllowComments', fallback: 'Comments' },
  { key: 'event_default_allow_reactions', label: 'settings.events.defaultAllowReactions', fallback: 'Emoji reactions' },
  { key: 'event_default_allow_color_labels', label: 'settings.events.defaultAllowColorLabels', fallback: 'Color labels' },
];

export const EventsTab: React.FC<EventsTabProps> = ({
  eventSettings,
  setEventSettings,
  saveEventSettingsMutation,
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
          {t('settings.events.requiredFields', 'Required Fields')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.events.requiredFieldsDescription', 'Configure which contact fields are required when creating new events.')}
        </p>

        <div className="space-y-4">
          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_require_customer_name}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_require_customer_name: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.requireCustomerName', 'Require customer name')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.requireCustomerNameHelp', 'Customer name must be provided for new events')}
                </p>
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_require_customer_email}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_require_customer_email: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.requireCustomerEmail', 'Require customer email')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.requireCustomerEmailHelp', 'Customer email must be provided for new events')}
                </p>
                {!eventSettings.event_require_customer_email && (
                  <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {t('settings.events.customerEmailWarning', 'Required for sending gallery invitations')}
                  </p>
                )}
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_require_admin_email}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_require_admin_email: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.requireAdminEmail', 'Require admin email')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.requireAdminEmailHelp', 'Admin email must be provided for new events')}
                </p>
                {!eventSettings.event_require_admin_email && (
                  <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {t('settings.events.adminEmailWarning', 'Required for receiving event notifications')}
                  </p>
                )}
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_require_event_date}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_require_event_date: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.requireEventDate', 'Require event date')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.requireEventDateHelp', 'Event date must be provided when creating events')}
                </p>
                {!eventSettings.event_require_event_date && (
                  <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {t('settings.events.eventDateWarning', 'Gallery URLs will use random identifiers instead of dates')}
                  </p>
                )}
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_require_expiration}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_require_expiration: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.requireExpiration', 'Require expiration date')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.requireExpirationHelp', 'Galleries must have an expiration date')}
                </p>
                {!eventSettings.event_require_expiration && (
                  <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {t('settings.events.expirationWarning', 'Galleries without expiration will remain active until manually archived')}
                  </p>
                )}
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_default_require_password}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_default_require_password: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.defaultRequirePassword', 'Require password by default')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.defaultRequirePasswordHelp', 'Pre-check "Require password" when creating new events. Disable for quicker creation of public galleries.')}
                </p>
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_default_feedback_enabled}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_default_feedback_enabled: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.defaultFeedbackEnabled', 'Enable Guest Feedback by default')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.defaultFeedbackEnabledHelp', 'Pre-check "Guest Feedback" when creating new events. Individual feedback options (likes, ratings, comments) can still be customised per event.')}
                </p>
              </div>
            </label>
          </div>

          {/* Per-type guest-feedback defaults (#1044). Defaults for NEW
              galleries — existing galleries keep whatever they were created
              with, so flipping one here can never change a gallery a client
              is in the middle of. Greyed out rather than hidden while the
              master default is off, so the options stay discoverable. */}
          <div
            className={`ml-7 pl-4 border-l border-neutral-200 dark:border-neutral-700 space-y-3 ${
              eventSettings.event_default_feedback_enabled ? '' : 'opacity-50'
            }`}
          >
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t(
                'settings.events.feedbackTypeDefaultsHelp',
                'Which feedback types new galleries start with. Existing galleries are not affected — each gallery can still be changed individually.'
              )}
            </p>

            {FEEDBACK_TYPE_DEFAULTS.map(({ key, label, fallback }) => (
              <label key={key} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  disabled={!eventSettings.event_default_feedback_enabled}
                  checked={eventSettings[key]}
                  onChange={(e) => setEventSettings(prev => ({ ...prev, [key]: e.target.checked }))}
                  className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
                />
                <span className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-2">
                  {t(label, fallback)}
                  {key === 'event_default_allow_color_labels' && (
                    <span className="flex items-center gap-1" aria-hidden="true">
                      {COLOR_LABELS.map((color) => (
                        <span
                          key={color}
                          className="w-3 h-3 rounded-full border"
                          style={{
                            backgroundColor: COLOR_LABEL_SWATCHES[color].fill,
                            borderColor: COLOR_LABEL_SWATCHES[color].ring,
                          }}
                        />
                      ))}
                    </span>
                  )}
                </span>
              </label>
            ))}

            <div>
              <label
                className="block text-sm text-neutral-700 dark:text-neutral-300 mb-1"
                htmlFor="event_default_keybind_mode"
              >
                {t('settings.events.defaultKeybindMode', 'Default lightbox shortcuts')}
              </label>
              <select
                id="event_default_keybind_mode"
                disabled={!eventSettings.event_default_feedback_enabled}
                value={eventSettings.event_default_keybind_mode}
                onChange={(e) => setEventSettings(prev => ({
                  ...prev,
                  event_default_keybind_mode: e.target.value === 'lightroom' ? 'lightroom' : 'colors',
                }))}
                className="w-full max-w-sm px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm"
              >
                <option value="colors">
                  {t('settings.events.keybindColors', 'Colors only — 1 green, 2 yellow, 3 red')}
                </option>
                <option value="lightroom">
                  {t('settings.events.keybindLightroom', 'Lightroom — 1-5 stars, 6-9 colors')}
                </option>
              </select>
            </div>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.gallery_show_filter_bar}
                onChange={(e) => setEventSettings(prev => ({ ...prev, gallery_show_filter_bar: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.showGalleryFilterBar', 'Show filter bar in galleries')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.showGalleryFilterBarHelp', 'Display the search-by-filename and sort controls above grid-layout galleries. Disable for a cleaner layout.')}
                </p>
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_phone_field_enabled}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_phone_field_enabled: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('settings.events.enablePhoneField', 'Enable phone number field')}
                </span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('settings.events.enablePhoneFieldHelp', 'Adds an optional phone number input to the event form. Useful for downstream automations like WhatsApp delivery via n8n. Always optional even when enabled.')}
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="mt-6">
          <Button
            variant="primary"
            onClick={() => saveEventSettingsMutation.mutate()}
            isLoading={saveEventSettingsMutation.isPending}
            leftIcon={<Save className="w-5 h-5" />}
          >
            {t('settings.events.saveSettings', 'Save Event Settings')}
          </Button>
        </div>
      </Card>

      <Card padding="md">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium mb-1">{t('settings.events.noteTitle', 'Note')}</p>
            <p>
              {t('settings.events.noteText', 'These settings only affect new event creation. Existing events are not affected. Default behavior requires all fields.')}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};
