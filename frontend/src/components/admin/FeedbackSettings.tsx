import React from 'react';
import { MessageSquare, Star, Heart, Bookmark, Shield, Eye, User, Users } from 'lucide-react';
import { Card } from '../common';
import { useTranslation } from 'react-i18next';

interface FeedbackSettingsProps {
  settings: FeedbackSettings;
  onChange: (settings: FeedbackSettings) => void;
  className?: string;
}

interface FeedbackSettings {
  feedback_enabled: boolean;
  allow_ratings: boolean;
  allow_likes: boolean;
  allow_comments: boolean;
  allow_favorites: boolean;
  require_name_email: boolean;
  moderate_comments: boolean;
  show_feedback_to_guests: boolean;
  enable_rate_limiting: boolean;
  rate_limit_window_minutes?: number;
  rate_limit_max_requests?: number;
  identity_mode?: 'simple' | 'guest';
  // Per-guest caps (#655). null/0 = unlimited.
  max_favorites_per_guest?: number | null;
  max_likes_per_guest?: number | null;
}

export const FeedbackSettings: React.FC<FeedbackSettingsProps> = ({
  settings,
  onChange,
  className = ''
}) => {
  const { t } = useTranslation();

  const handleToggle = (field: keyof FeedbackSettings) => {
    onChange({
      ...settings,
      [field]: !settings[field]
    });
  };

  const handleNumberChange = (field: keyof FeedbackSettings, value: string) => {
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue)) {
      onChange({
        ...settings,
        [field]: numValue
      });
    }
  };

  return (
    <Card className={className}>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            {t('feedback.settings.title', 'Guest Feedback Settings')}
          </h2>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.feedback_enabled}
              onChange={() => handleToggle('feedback_enabled')}
              className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
            />
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {t('feedback.settings.enableFeedback', 'Enable feedback')}
            </span>
          </label>
        </div>

        {settings.feedback_enabled && (
          <>
            {/* Identity Mode */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {t('feedback.settings.identityMode', 'Identity Mode')}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer border transition ${
                    (settings.identity_mode || 'simple') === 'simple'
                      ? 'border-accent-dark bg-accent-dark/15'
                      : 'border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="identity_mode"
                    value="simple"
                    checked={(settings.identity_mode || 'simple') === 'simple'}
                    onChange={() => onChange({ ...settings, identity_mode: 'simple' })}
                    className="mt-0.5 w-4 h-4 text-accent focus:ring-primary-500"
                  />
                  <User className="w-5 h-5 mt-0.5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.identityModeSimple', 'Simple feedback')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t(
                        'feedback.settings.identityModeSimpleDesc',
                        'Anonymous, device-based. All visitors on the same device share state.'
                      )}
                    </div>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer border transition ${
                    settings.identity_mode === 'guest'
                      ? 'border-accent-dark bg-accent-dark/15'
                      : 'border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="identity_mode"
                    value="guest"
                    checked={settings.identity_mode === 'guest'}
                    onChange={() => onChange({ ...settings, identity_mode: 'guest' })}
                    className="mt-0.5 w-4 h-4 text-accent focus:ring-primary-500"
                  />
                  <Users className="w-5 h-5 mt-0.5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.identityModeGuest', 'Per-guest selections')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t(
                        'feedback.settings.identityModeGuestDesc',
                        'Each visitor enters their name. Enables per-guest tracking and admin insights.'
                      )}
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4" />

            {/* Feedback Types */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {t('feedback.settings.feedbackTypes', 'Feedback Types')}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="flex items-center gap-3 p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-700">
                  <input
                    type="checkbox"
                    checked={settings.allow_ratings}
                    onChange={() => handleToggle('allow_ratings')}
                    className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <Star className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.ratings', 'Star Ratings')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('feedback.settings.ratingsDesc', 'Allow guests to rate photos (1-5 stars)')}
                    </div>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-700">
                  <input
                    type="checkbox"
                    checked={settings.allow_likes}
                    onChange={() => handleToggle('allow_likes')}
                    className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <Heart className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.likes', 'Likes')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('feedback.settings.likesDesc', 'Simple like/unlike functionality')}
                    </div>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-700">
                  <input
                    type="checkbox"
                    checked={settings.allow_comments}
                    onChange={() => handleToggle('allow_comments')}
                    className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <MessageSquare className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.comments', 'Comments')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('feedback.settings.commentsDesc', 'Text comments on photos')}
                    </div>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-700">
                  <input
                    type="checkbox"
                    checked={settings.allow_favorites}
                    onChange={() => handleToggle('allow_favorites')}
                    className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <Bookmark className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.favorites', 'Favorites')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('feedback.settings.favoritesDesc', 'Mark photos as favorites')}
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Per-guest caps (#655). Two numeric inputs; 0 / empty = unlimited.
                Only renders when the matching toggle is on — the cap is
                meaningless if the type itself is disabled. */}
            {(settings.allow_favorites || settings.allow_likes) && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('feedback.settings.perGuestLimits', 'Per-guest limits')}
                </h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t(
                    'feedback.settings.perGuestLimitsDesc',
                    'Cap how many photos each guest can favorite or like — useful for "pick your top N for the album" workflows. Leave at 0 for no limit. Lowering a cap below an existing guest\'s count keeps their existing rows; only new adds are blocked until they remove some.',
                  )}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {settings.allow_favorites && (
                    <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">
                        {t('feedback.settings.maxFavoritesPerGuest', 'Max favorites per guest')}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step={1}
                        value={settings.max_favorites_per_guest ?? 0}
                        onChange={(e) => onChange({
                          ...settings,
                          max_favorites_per_guest: Math.max(0, parseInt(e.target.value, 10) || 0),
                        })}
                        className="w-32 px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
                      />
                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        {t('feedback.settings.maxFavoritesPerGuestHint', '0 = unlimited')}
                      </p>
                    </div>
                  )}
                  {settings.allow_likes && (
                    <div className="p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                      <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">
                        {t('feedback.settings.maxLikesPerGuest', 'Max likes per guest')}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step={1}
                        value={settings.max_likes_per_guest ?? 0}
                        onChange={(e) => onChange({
                          ...settings,
                          max_likes_per_guest: Math.max(0, parseInt(e.target.value, 10) || 0),
                        })}
                        className="w-32 px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
                      />
                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        {t('feedback.settings.maxLikesPerGuestHint', '0 = unlimited')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4" />

            {/* Privacy & Moderation */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {t('feedback.settings.privacyModeration', 'Privacy & Moderation')}
              </h3>
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.require_name_email}
                    onChange={() => handleToggle('require_name_email')}
                    className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.requireInfo', 'Require Name & Email')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('feedback.settings.requireInfoDesc', 'Guests must provide name and email to leave feedback')}
                    </div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.moderate_comments}
                    onChange={() => handleToggle('moderate_comments')}
                    disabled={!settings.allow_comments}
                    className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500 disabled:opacity-50"
                  />
                  <Shield className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.moderateComments', 'Moderate Comments')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('feedback.settings.moderateCommentsDesc', 'Comments require approval before being visible')}
                    </div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.show_feedback_to_guests}
                    onChange={() => handleToggle('show_feedback_to_guests')}
                    className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
                  />
                  <Eye className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('feedback.settings.showToGuests', 'Show Feedback to Guests')}
                    </div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('feedback.settings.showToGuestsDesc', 'Other guests can see ratings, likes, and approved comments')}
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4" />

            {/* Rate Limiting */}
            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.enable_rate_limiting}
                  onChange={() => handleToggle('enable_rate_limiting')}
                  className="w-4 h-4 text-accent bg-neutral-100 border-neutral-300 rounded focus:ring-primary-500"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {t('feedback.settings.enableRateLimiting', 'Enable Rate Limiting')}
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t('feedback.settings.rateLimitingDesc', 'Prevent spam by limiting feedback frequency')}
                  </div>
                </div>
              </label>

              {settings.enable_rate_limiting && (
                <div className="grid grid-cols-2 gap-4 ml-7">
                  <div>
                    <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">
                      {t('feedback.settings.timeWindow', 'Time Window (minutes)')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      value={settings.rate_limit_window_minutes || 15}
                      onChange={(e) => handleNumberChange('rate_limit_window_minutes', e.target.value)}
                      className="w-full px-3 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-primary-500 focus:border-accent-dark"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">
                      {t('feedback.settings.maxRequests', 'Max Requests')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={settings.rate_limit_max_requests || 10}
                      onChange={(e) => handleNumberChange('rate_limit_max_requests', e.target.value)}
                      className="w-full px-3 py-1.5 text-sm border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-primary-500 focus:border-accent-dark"
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
};