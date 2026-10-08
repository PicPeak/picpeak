import React from 'react';
import { AlertCircle } from 'lucide-react';
import { Card } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import type { EventSettings } from '../hooks/useSettingsState';
import { COLOR_LABEL_SWATCHES, COLOR_LABELS } from '../../../services/feedback.service';
import { UploaderNameSettings } from '../../../components/admin/UploaderNameSettings';

interface EventsTabProps {
  eventSettings: EventSettings;
  setEventSettings: React.Dispatch<React.SetStateAction<EventSettings>>;
  saveEventSettingsMutation: {
    mutate: () => void;
    isPending: boolean;
  };
  isDirty: boolean;
  onDiscard: () => void;
}

/**
 * The per-type feedback defaults, in the order the per-event panel shows
 * them. Mirrors FEEDBACK_TOGGLES in backend services/feedbackDefaults.js.
 */
const FEEDBACK_TYPE_DEFAULTS: Array<{
  key: 'event_default_allow_ratings' | 'event_default_allow_likes'
    | 'event_default_allow_favorites' | 'event_default_allow_comments'
    | 'event_default_allow_reactions' | 'event_default_allow_color_labels'
    | 'event_default_allow_decisions';
  label: string;
  fallback: string;
}> = [
  { key: 'event_default_allow_ratings', label: 'settings.events.defaultAllowRatings', fallback: 'Star ratings' },
  { key: 'event_default_allow_likes', label: 'settings.events.defaultAllowLikes', fallback: 'Likes' },
  { key: 'event_default_allow_favorites', label: 'settings.events.defaultAllowFavorites', fallback: 'Favourites' },
  { key: 'event_default_allow_comments', label: 'settings.events.defaultAllowComments', fallback: 'Comments' },
  { key: 'event_default_allow_reactions', label: 'settings.events.defaultAllowReactions', fallback: 'Emoji reactions' },
  { key: 'event_default_allow_color_labels', label: 'settings.events.defaultAllowColorLabels', fallback: 'Color labels' },
  { key: 'event_default_allow_decisions', label: 'settings.events.defaultAllowDecisions', fallback: 'Approve / reject per photo' },
];

export const EventsTab: React.FC<EventsTabProps> = ({
  eventSettings,
  setEventSettings,
  saveEventSettingsMutation,
  isDirty,
  onDiscard,
}) => {
  const { t } = useTranslation();
  // The keyword field edits the raw text; the list is parsed from it on each
  // change but the text is not re-joined, so Backspace can delete the space
  // after a comma. Re-synced when the stored list changes elsewhere (load,
  // discard).
  const keywordList = eventSettings.first_look_folder_keywords.join(', ');
  const [keywordText, setKeywordText] = React.useState(keywordList);
  const lastSyncedKeywords = React.useRef(keywordList);
  React.useEffect(() => {
    const parsed = keywordText.split(',').map((k) => k.trim()).filter(Boolean).join(', ');
    if (keywordList !== lastSyncedKeywords.current && keywordList !== parsed) setKeywordText(keywordList);
    lastSyncedKeywords.current = keywordList;
  }, [keywordList, keywordText]);

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading mb-4">
          {t('settings.events.requiredFields', 'Required Fields')}
        </h2>
        <p className="text-sm text-soft mb-4">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.requireCustomerName', 'Require customer name')}
                </span>
                <p className="text-xs text-muted mt-1">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.requireCustomerEmail', 'Require customer email')}
                </span>
                <p className="text-xs text-muted mt-1">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.requireAdminEmail', 'Require admin email')}
                </span>
                <p className="text-xs text-muted mt-1">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.requireEventDate', 'Require event date')}
                </span>
                <p className="text-xs text-muted mt-1">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.requireExpiration', 'Require expiration date')}
                </span>
                <p className="text-xs text-muted mt-1">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.defaultRequirePassword', 'Require password by default')}
                </span>
                <p className="text-xs text-muted mt-1">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.defaultFeedbackEnabled', 'Enable Guest Feedback by default')}
                </span>
                <p className="text-xs text-muted mt-1">
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
            className={`ml-7 pl-4 border-l border-line space-y-3 ${
              eventSettings.event_default_feedback_enabled ? '' : 'opacity-50'
            }`}
          >
            <p className="text-xs text-muted">
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
                <span className="text-sm text-body flex items-center gap-2">
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
                className="block text-sm text-body mb-1"
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
                className="w-full max-w-sm px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading text-sm"
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

          {/* Download limit default (issue 1560) */}
          <div>
            <label
              className="block text-sm font-medium text-body mb-1"
              htmlFor="event_default_download_limit"
            >
              {t('settings.events.defaultDownloadLimit', 'Default download limit')}
            </label>
            <input
              id="event_default_download_limit"
              type="number"
              min={0}
              max={2147483647}
              value={eventSettings.event_default_download_limit}
              onChange={(e) => setEventSettings(prev => ({
                ...prev,
                event_default_download_limit: Math.max(0, parseInt(e.target.value, 10) || 0),
              }))}
              className="w-32 px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading text-sm"
            />
            <p className="text-xs text-muted mt-1">
              {t('settings.events.defaultDownloadLimitHelp', 'Pre-filled on new events: how many photos a client can download. 0 = unlimited.')}
            </p>
          </div>

          {/* Folders + two-stage delivery (issues 1786, 1562): defaults for new
              galleries, and the keyword folders that start a first look. */}
          <div className="space-y-4 rounded-lg border border-line p-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.event_default_folder_structure}
                onChange={(e) => setEventSettings(prev => ({ ...prev, event_default_folder_structure: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-body">
                  {t('settings.events.defaultFolderStructure', 'Mirror folder structure in new galleries')}
                </span>
                <p className="text-xs text-muted mt-1">
                  {t('settings.events.defaultFolderStructureHelp', 'Subfolders of uploads and external folders become nested gallery folders. Existing galleries keep their own setting.')}
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.first_look_keyword_detection}
                onChange={(e) => setEventSettings(prev => ({ ...prev, first_look_keyword_detection: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-body">
                  {t('settings.events.firstLookDetection', 'Start a first look from keyword folders')}
                </span>
                <p className="text-xs text-muted mt-1">
                  {t('settings.events.firstLookDetectionHelp', 'A top-level folder whose name contains one of these words (e.g. "Wedding (FirstLook)") is not created as a folder: its photos are badged and the gallery switches to two-stage delivery.')}
                </p>
              </div>
            </label>
            {eventSettings.first_look_keyword_detection && (
              <div>
                <label className="block text-sm font-medium text-body mb-1" htmlFor="first_look_folder_keywords">
                  {t('settings.events.firstLookKeywords', 'Keywords')}
                </label>
                <input
                  id="first_look_folder_keywords"
                  type="text"
                  value={keywordText}
                  onChange={(e) => {
                    setKeywordText(e.target.value);
                    setEventSettings(prev => ({
                      ...prev,
                      first_look_folder_keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean),
                    }));
                  }}
                  className="w-full max-w-md px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading text-sm"
                />
                <p className="text-xs text-muted mt-1">
                  {t('settings.events.firstLookKeywordsHelp', 'Comma-separated. Case, spaces, dashes and underscores are ignored, so "FirstLook" also matches "first-look".')}
                </p>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-body mb-1" htmlFor="event_default_delivery_days">
                {t('settings.events.deliveryDays', 'Full gallery due after (days)')}
              </label>
              <input
                id="event_default_delivery_days"
                type="number"
                min={1}
                max={365}
                value={eventSettings.event_default_delivery_days}
                onChange={(e) => setEventSettings(prev => ({
                  ...prev,
                  event_default_delivery_days: Math.min(365, Math.max(1, parseInt(e.target.value, 10) || 1)),
                }))}
                className="w-32 px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading text-sm"
              />
              <p className="text-xs text-muted mt-1">
                {t('settings.events.deliveryDaysHelp', 'When a first look starts without a promised date, the full gallery is due this many days after the event date.')}
              </p>
            </div>
          </div>

          {/* Uploader names (#1561): defaults for new galleries only. */}
          <UploaderNameSettings
            className="max-w-sm"
            idPrefix="event-default-uploader-names"
            mode={eventSettings.event_default_guest_name_mode}
            onModeChange={(mode) => setEventSettings(prev => ({ ...prev, event_default_guest_name_mode: mode }))}
            showToGuests={eventSettings.event_default_show_credits_to_guests}
            onShowToGuestsChange={(show) => setEventSettings(prev => ({ ...prev, event_default_show_credits_to_guests: show }))}
          />

          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={eventSettings.gallery_show_filter_bar}
                onChange={(e) => setEventSettings(prev => ({ ...prev, gallery_show_filter_bar: e.target.checked }))}
                className="mt-1 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-body">
                  {t('settings.events.showGalleryFilterBar', 'Show filter bar in galleries')}
                </span>
                <p className="text-xs text-muted mt-1">
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
                <span className="text-sm font-medium text-body">
                  {t('settings.events.enablePhoneField', 'Enable phone number field')}
                </span>
                <p className="text-xs text-muted mt-1">
                  {t('settings.events.enablePhoneFieldHelp', 'Adds an optional phone number input to the event form. Useful for downstream automations like WhatsApp delivery via n8n. Always optional even when enabled.')}
                </p>
              </div>
            </label>
          </div>
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

      <SettingsSaveBar

        isDirty={isDirty}

        isSaving={saveEventSettingsMutation.isPending}

        onSave={() => saveEventSettingsMutation.mutate()}

        onDiscard={onDiscard}

      />
    </div>
  );
};
