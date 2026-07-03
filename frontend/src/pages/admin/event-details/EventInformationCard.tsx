import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  Download,
  Upload,
  Image,
  Lock,
  Eye,
  EyeOff,
  Shield,
  Monitor,
  Droplets,
  MousePointer,
  Layout,
  Trash2
} from 'lucide-react';
import type { Event } from '../../../types';
import { Input, Card, Loading, MarkdownContent, LocalizedDateInput } from '../../../components/common';
import { HeroPhotoSelector, FocalPointPicker, FeedbackSettings } from '../../../components/admin';
import { CustomerAccountPicker } from '../../../components/admin/CustomerAccountPicker';
import { api } from '../../../config/api';
import { buildResourceUrl } from '../../../utils/url';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import type { AdminPhoto } from '../../../services/photos.service';
import type { FeedbackSettings as FeedbackSettingsType } from '../../../services/feedback.service';
import { ExternalFolderPicker } from './ExternalFolderPicker';
import { safeParseDate } from './utils';
import type { EditFormState } from './types';

interface EventInformationCardProps {
  event: Event;
  id: string | undefined;
  isEditing: boolean;
  editForm: EditFormState;
  setEditForm: React.Dispatch<React.SetStateAction<EditFormState>>;
  showNewPassword: boolean;
  setShowNewPassword: (show: boolean) => void;
  feedbackSettings: FeedbackSettingsType;
  setFeedbackSettings: React.Dispatch<React.SetStateAction<FeedbackSettingsType>>;
  categories: Array<{ id: number; name: string; slug: string }>;
  photos: AdminPhoto[];
  phoneFieldEnabled: boolean;
  daysUntilExpiration: number | null;
}

export const EventInformationCard: React.FC<EventInformationCardProps> = ({
  event,
  id,
  isEditing,
  editForm,
  setEditForm,
  showNewPassword,
  setShowNewPassword,
  feedbackSettings,
  setFeedbackSettings,
  categories,
  photos,
  phoneFieldEnabled,
  daysUntilExpiration
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [logoUploading, setLogoUploading] = useState(false);

  const handleEventLogoUpload = async (file: File) => {
    if (!id) return;
    setLogoUploading(true);
    try {
      const formData = new FormData();
      formData.append('logo', file);
      await api.post(`/admin/events/${id}/logo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success(t('events.eventLogoUploaded', 'Event logo uploaded successfully'));
      queryClient.invalidateQueries({ queryKey: ['event', id] });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('events.eventLogoUploadFailed', 'Failed to upload event logo'));
    } finally {
      setLogoUploading(false);
    }
  };

  const handleEventLogoRemove = async () => {
    if (!id) return;
    setLogoUploading(true);
    try {
      await api.delete(`/admin/events/${id}/logo`);
      toast.success(t('events.eventLogoRemoved', 'Event logo removed successfully'));
      queryClient.invalidateQueries({ queryKey: ['event', id] });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('events.eventLogoRemoveFailed', 'Failed to remove event logo'));
    } finally {
      setLogoUploading(false);
    }
  };

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.eventInformation')}</h2>

      {isEditing ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('events.welcomeMessageLabel')}
            </label>
            <textarea
              value={editForm.welcome_message}
              onChange={(e) => setEditForm(prev => ({ ...prev, welcome_message: e.target.value }))}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              rows={3}
              placeholder={t('events.welcomeMessage')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('events.hostName')}
            </label>
            <Input
              type="text"
              value={editForm.customer_name}
              onChange={(e) => setEditForm(prev => ({ ...prev, customer_name: e.target.value }))}
              placeholder={t('events.hostNamePlaceholder')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('events.hostEmail')}
            </label>
            <Input
              type="email"
              value={editForm.customer_email}
              onChange={(e) => setEditForm(prev => ({ ...prev, customer_email: e.target.value }))}
              placeholder={t('events.hostEmailPlaceholder')}
            />
          </div>

          {phoneFieldEnabled && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('events.customerPhone', 'Customer Phone')} ({t('common.optional')})
              </label>
              <Input
                type="tel"
                value={editForm.customer_phone}
                onChange={(e) => setEditForm(prev => ({ ...prev, customer_phone: e.target.value }))}
                placeholder={t('events.customerPhonePlaceholder', '+1 555 555 1234')}
              />
            </div>
          )}

          {/* Customer accounts (#354). Picker self-hides when the
              customerPortal feature flag is off. */}
          <CustomerAccountPicker
            value={editForm.customer_accounts}
            onChange={(next) => setEditForm((prev) => ({ ...prev, customer_accounts: next }))}
          />

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('events.expirationDate')}
            </label>
            <LocalizedDateInput
              value={editForm.expires_at}
              onChange={(iso) => setEditForm(prev => ({ ...prev, expires_at: iso }))}
              min={format(new Date(), 'yyyy-MM-dd')}
            />
          </div>

          {/* Hero Photo Selection */}
          <HeroPhotoSelector
            photos={photos || []}
            currentHeroPhotoId={editForm.hero_photo_id}
            onSelect={(photoId) => setEditForm(prev => ({ ...prev, hero_photo_id: photoId }))}
            isEditing={isEditing}
          />

          {/* Per-event social-share opt-in (#474). Toggle is
              disabled when no hero photo is picked — there's
              nothing to surface as the cover. The help text
              deliberately spells out the public-by-design
              consequence so an admin doesn't flip this on for
              a sensitive gallery without realising what they're
              sharing with link-preview crawlers. */}
          <div className="ml-6 mt-3">
            <label className={`flex items-start gap-2 cursor-pointer ${editForm.hero_photo_id ? '' : 'opacity-60 cursor-not-allowed'}`}>
              <input
                type="checkbox"
                className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                checked={editForm.og_image_share_enabled === true}
                disabled={!editForm.hero_photo_id}
                onChange={(e) => setEditForm(prev => ({ ...prev, og_image_share_enabled: e.target.checked }))}
              />
              <span className="text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  {t('events.ogShare.title', 'Use hero photo as social-share preview')}
                </span>
                <span className="block text-xs text-neutral-600 dark:text-neutral-400 mt-0.5">
                  {editForm.hero_photo_id
                    ? t('events.ogShare.help', 'When this gallery URL is shared on WhatsApp, Facebook, Slack, etc., the link preview will show the hero photo above. The thumbnail is fetched unauthenticated by link-preview crawlers — anyone with the URL effectively makes this image public. Off by default; pick a hero you are comfortable surfacing publicly before enabling.')
                    : t('events.ogShare.heroRequired', 'Pick a hero photo above first — this option uses it as the WhatsApp / Facebook / Slack preview image.')}
                </span>
              </span>
            </label>
          </div>

          {/* Hero Image Focal Point Picker (#162) */}
          {editForm.hero_photo_id && (() => {
            const heroPhoto = (photos || []).find((p) => p.id === editForm.hero_photo_id);
            const heroImageUrl = heroPhoto?.thumbnail_url || heroPhoto?.url;
            if (!heroImageUrl) return null;
            return (
              <div className="ml-6 mt-2">
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('events.heroImageAnchor', 'Hero Image Crop Position')}
                </label>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                  {t('events.heroImageAnchorDescription', 'Click on the image to set the focal point for cropping.')}
                </p>
                <FocalPointPicker
                  imageUrl={heroImageUrl}
                  currentValue={editForm.hero_image_anchor}
                  onChange={(value) => setEditForm(prev => ({ ...prev, hero_image_anchor: value }))}
                  slug={event.slug}
                />
              </div>
            );
          })()}

          <div>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                checked={editForm.require_password}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setEditForm(prev => ({
                    ...prev,
                    require_password: checked,
                    new_password: checked ? prev.new_password : '',
                    confirm_new_password: checked ? prev.confirm_new_password : '',
                  }));
                  if (!checked) {
                    setShowNewPassword(false);
                  }
                }}
              />
              <div>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('events.requirePasswordToggle')}</span>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('events.requirePasswordToggleHelp', 'Disable this if you want to share the gallery without a password. Anyone with the link will be able to view the photos.')}
                </p>
              </div>
            </label>

            {!editForm.require_password && (
              <div className="mt-2 rounded-md border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/30 p-3 text-xs text-orange-800 dark:text-orange-300">
                {t('events.publicGalleryWarning', 'Public galleries are accessible to anyone with the link. Consider enabling download watermarks and monitoring activity.')}
              </div>
            )}
          </div>

          {editForm.require_password && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('events.newPasswordLabel', 'New gallery password')}
                </label>
                <div className="relative">
                  <Input
                    type={showNewPassword ? 'text' : 'password'}
                    value={editForm.new_password}
                    onChange={(e) => setEditForm(prev => ({ ...prev, new_password: e.target.value }))}
                    placeholder={t('events.enterPassword')}
                    leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  >
                    {showNewPassword ? (
                      <EyeOff className="w-5 h-5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300" />
                    ) : (
                      <Eye className="w-5 h-5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300" />
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('events.confirmPassword')}
                </label>
                <Input
                  type={showNewPassword ? 'text' : 'password'}
                  value={editForm.confirm_new_password}
                  onChange={(e) => setEditForm(prev => ({ ...prev, confirm_new_password: e.target.value }))}
                  placeholder={t('events.confirmPasswordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('events.sourceMode', 'Source Mode')}
            </label>
            <select
              value={editForm.source_mode}
              onChange={(e) => {
                const mode = e.target.value as 'managed' | 'reference';
                setEditForm(prev => ({
                  ...prev,
                  source_mode: mode,
                  external_path: mode === 'reference'
                    ? (prev.external_path || event.external_path || '')
                    : ''
                }));
              }}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
            >
              <option value="managed">{t('events.sourceModeManaged', 'Managed (upload to PicPeak)')}</option>
              <option value="reference">{t('events.sourceModeReference', 'Reference external folder')}</option>
            </select>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('events.sourceModeHelp', 'Use managed mode for direct uploads or reference an external folder that is mounted at /external-media in Docker.')}
            </p>
          </div>

          {editForm.source_mode === 'reference' && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('events.externalFolder', 'External Folder')}
              </label>
              <ExternalFolderPicker
                value={editForm.external_path || ''}
                onChange={(folder) => setEditForm(prev => ({ ...prev, external_path: folder }))}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('events.externalFolderHint', 'These folders come from the /external-media mount inside the container. Ensure it is accessible to the backend process.')}
              </p>
            </div>
          )}

          {/* Photo Cap */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('events.photoCap', 'Photo Limit')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={editForm.photo_cap}
                onChange={(e) => setEditForm(prev => ({ ...prev, photo_cap: parseInt(e.target.value) || 0 }))}
                min={0}
                className="w-24 px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              />
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {t('events.photoCapHelp', 'Maximum number of photos allowed. 0 = unlimited')}
              </span>
            </div>
          </div>

          {/* Default Photo Sort */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('photoSort.defaultSort', 'Default Photo Sort')}
            </label>
            <select
              value={editForm.default_photo_sort}
              onChange={(e) => setEditForm(prev => ({ ...prev, default_photo_sort: e.target.value }))}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
            >
              <option value="upload_date_desc">{t('photoSort.uploadDateNewest', 'Upload Date (Newest First)')}</option>
              <option value="upload_date_asc">{t('photoSort.uploadDateOldest', 'Upload Date (Oldest First)')}</option>
              <option value="capture_date_desc">{t('photoSort.captureDateNewest', 'Date Taken (Newest First)')}</option>
              <option value="capture_date_asc">{t('photoSort.captureDateOldest', 'Date Taken (Oldest First)')}</option>
              <option value="filename_asc">{t('photoSort.filenameAZ', 'Filename (A-Z)')}</option>
              <option value="filename_desc">{t('photoSort.filenameZA', 'Filename (Z-A)')}</option>
            </select>
          </div>

          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={editForm.allow_user_uploads}
                onChange={(e) => setEditForm(prev => ({ ...prev, allow_user_uploads: e.target.checked }))}
                className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
              />
              <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('events.allowUserUploads')}</span>
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 ml-6">
              {t('events.allowUserUploadsHelp')}
            </p>
          </div>

          {editForm.allow_user_uploads && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('events.uploadCategory')}
              </label>
              <select
                value={editForm.upload_category_id || ''}
                onChange={(e) => setEditForm(prev => ({
                  ...prev,
                  upload_category_id: e.target.value ? parseInt(e.target.value) : null
                }))}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              >
                <option value="">{t('events.selectCategory')}</option>
                {categories?.map(category => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('events.uploadCategoryHelp')}
              </p>
            </div>
          )}

          {/* Feedback Settings */}
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('feedback.settings.title', 'Guest Feedback Settings')}</h3>
            <FeedbackSettings
              settings={feedbackSettings}
              onChange={setFeedbackSettings}
            />
          </div>

          {/* Promotional Banner Override (#440) — three-way: inherit / custom / off */}
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
              {t('events.promoBanner.title', 'Promotional Banner')}
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
              {t('events.promoBanner.help', 'Choose how this gallery handles the promotional banner. "Inherit" uses your global default; "Custom" overrides it for this event; "Off" hides it entirely.')}
            </p>
            <div className="space-y-2">
              {(['inherit', 'custom', 'off'] as const).map((mode) => (
                <label key={mode} className="flex items-center">
                  <input
                    type="radio"
                    name="promo_mode"
                    value={mode}
                    checked={editForm.promo_mode === mode}
                    onChange={() => setEditForm(prev => ({ ...prev, promo_mode: mode }))}
                    className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 focus:ring-primary-500"
                  />
                  <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">
                    {t(`events.promoBanner.mode_${mode}`, mode === 'inherit' ? 'Inherit global default' : mode === 'custom' ? 'Custom override for this event' : 'Off (hide for this event)')}
                  </span>
                </label>
              ))}
            </div>
            {editForm.promo_mode === 'custom' && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={editForm.promo_markdown}
                  onChange={(e) => setEditForm(prev => ({ ...prev, promo_markdown: e.target.value }))}
                  rows={5}
                  placeholder={t('events.promoBanner.placeholder', 'Markdown content (e.g. **Special offer:** [book your next session](https://example.com))')}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark font-mono text-sm"
                />
                {editForm.promo_markdown.trim() && (
                  <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 bg-neutral-50 dark:bg-neutral-900">
                    <p className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-2">
                      {t('events.promoBanner.preview', 'Preview')}
                    </p>
                    <MarkdownContent source={editForm.promo_markdown} className="text-sm text-neutral-800 dark:text-neutral-200 prose-sm prose-a:text-primary-600 dark:prose-a:text-primary-400" />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Download Protection Settings */}
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4 text-accent" />
              {t('events.downloadProtection', 'Download Protection')}
            </h3>

            <div className="space-y-3">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={editForm.allow_downloads}
                  onChange={(e) => setEditForm(prev => ({ ...prev, allow_downloads: e.target.checked }))}
                  className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                />
                <Download className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.allowDownloads', 'Allow photo downloads')}</span>
              </label>

              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={editForm.disable_right_click}
                  onChange={(e) => setEditForm(prev => ({ ...prev, disable_right_click: e.target.checked }))}
                  className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                />
                <MousePointer className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.disableRightClick', 'Block right-click menu')}</span>
              </label>

              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={editForm.watermark_downloads}
                  onChange={(e) => setEditForm(prev => ({
                    ...prev,
                    watermark_downloads: e.target.checked,
                    // Watermarking and presigned URLs are mutually
                    // exclusive — presigned URLs serve raw bytes from
                    // S3 without going through the watermark pipeline.
                    allow_presigned_download: e.target.checked ? false : prev.allow_presigned_download,
                  }))}
                  className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                />
                <Droplets className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.watermarkDownloads', 'Add watermark to downloads')}</span>
              </label>

              <label
                className={`flex items-center ${editForm.watermark_downloads ? 'opacity-50 cursor-not-allowed' : ''}`}
                title={editForm.watermark_downloads
                  ? 'Disabled while watermarks are on — presigned URLs bypass the watermark pipeline.'
                  : 'When the backend uses STORAGE_BACKEND=s3, "Download All" returns a 5-minute presigned S3 URL instead of streaming through the backend. Saves bandwidth on huge galleries; bypasses watermarking.'
                }
              >
                <input
                  type="checkbox"
                  checked={!!editForm.allow_presigned_download}
                  disabled={editForm.watermark_downloads}
                  onChange={(e) => setEditForm(prev => ({ ...prev, allow_presigned_download: e.target.checked }))}
                  className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                />
                <Download className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">
                  {t('events.allowPresignedDownload', 'Allow direct S3 download (no watermark, S3 mode only)')}
                </span>
              </label>

              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={editForm.enable_devtools_protection}
                  onChange={(e) => setEditForm(prev => ({ ...prev, enable_devtools_protection: e.target.checked }))}
                  className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                />
                <Monitor className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.enableDevtoolsProtection', 'Detect developer tools')}</span>
              </label>

              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={editForm.use_canvas_rendering}
                  onChange={(e) => setEditForm(prev => ({ ...prev, use_canvas_rendering: e.target.checked }))}
                  className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                />
                <Image className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.useCanvasRendering', 'Canvas rendering (advanced protection)')}</span>
              </label>

              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                {t('events.protectionInfo', 'Protection features help prevent unauthorized downloads but cannot block all methods.')}
              </p>
            </div>
          </div>

          {/* Hero Logo Settings */}
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3 flex items-center gap-2">
              <Layout className="w-4 h-4 text-accent" />
              {t('events.heroLogoSettings', 'Hero Logo Settings')}
            </h3>

            <div className="space-y-3">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={editForm.hero_logo_visible}
                  onChange={(e) => setEditForm(prev => ({ ...prev, hero_logo_visible: e.target.checked }))}
                  className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                />
                <Image className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.heroLogoVisible', 'Display logo in hero section')}</span>
              </label>

              {editForm.hero_logo_visible && (
                <>
                  <div className="ml-6">
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('events.heroLogoSize', 'Logo Size')}
                    </label>
                    <select
                      value={editForm.hero_logo_size}
                      onChange={(e) => setEditForm(prev => ({ ...prev, hero_logo_size: e.target.value as 'small' | 'medium' | 'large' | 'xlarge' }))}
                      className="w-full sm:w-48 px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-accent-dark text-sm"
                    >
                      <option value="small">{t('events.heroLogoSizeSmall', 'Small')}</option>
                      <option value="medium">{t('events.heroLogoSizeMedium', 'Medium')}</option>
                      <option value="large">{t('events.heroLogoSizeLarge', 'Large')}</option>
                      <option value="xlarge">{t('events.heroLogoSizeXLarge', 'Extra Large')}</option>
                    </select>
                  </div>

                  <div className="ml-6">
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('events.heroLogoPosition', 'Logo Position')}
                    </label>
                    <select
                      value={editForm.hero_logo_position}
                      onChange={(e) => setEditForm(prev => ({ ...prev, hero_logo_position: e.target.value as 'top' | 'center' | 'bottom' }))}
                      className="w-full sm:w-48 px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-accent-dark text-sm"
                    >
                      <option value="top">{t('events.heroLogoPositionTop', 'Top (above title)')}</option>
                      <option value="center">{t('events.heroLogoPositionCenter', 'Center (between title and dates)')}</option>
                      <option value="bottom">{t('events.heroLogoPositionBottom', 'Bottom (below dates)')}</option>
                    </select>
                  </div>

                  {/* Custom Event Logo Upload */}
                  <div className="ml-6 mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-700">
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                      {t('events.eventCustomLogo', 'Custom Event Logo')}
                    </label>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                      {t('events.eventCustomLogoDescription', 'Upload a custom logo for this event. This overrides the global branding logo for this gallery only.')}
                    </p>

                    {event.hero_logo_url ? (
                      <div className="flex items-center gap-3">
                        <div className="w-16 h-16 border border-neutral-200 dark:border-neutral-600 rounded-md flex items-center justify-center bg-neutral-50 dark:bg-neutral-700 overflow-hidden">
                          <img
                            src={buildResourceUrl(event.hero_logo_url)}
                            alt={t('events.eventCustomLogo', 'Custom Event Logo')}
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="cursor-pointer inline-flex items-center gap-1 text-xs text-accent hover:opacity-80">
                            <Upload className="w-3 h-3" />
                            {t('events.replaceLogo', 'Replace')}
                            <input
                              type="file"
                              className="hidden"
                              accept="image/png,image/jpeg,image/gif,image/svg+xml"
                              disabled={logoUploading}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleEventLogoUpload(file);
                                e.target.value = '';
                              }}
                            />
                          </label>
                          <button
                            type="button"
                            onClick={handleEventLogoRemove}
                            disabled={logoUploading}
                            className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="w-3 h-3" />
                            {t('events.removeLogo', 'Remove')}
                          </button>
                        </div>
                        {logoUploading && <Loading size="sm" />}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <label className={`cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-700 ${logoUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                          <Upload className="w-3.5 h-3.5" />
                          {t('events.uploadEventLogo', 'Upload Logo')}
                          <input
                            type="file"
                            className="hidden"
                            accept="image/png,image/jpeg,image/gif,image/svg+xml"
                            disabled={logoUploading}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleEventLogoUpload(file);
                              e.target.value = '';
                            }}
                          />
                        </label>
                        {logoUploading && <Loading size="sm" />}
                      </div>
                    )}
                  </div>
                </>
              )}

              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                {t('events.heroLogoInfo', 'These settings apply when the gallery uses the Hero layout. You can hide the logo or customize its size and position.')}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <dl className="space-y-4">
          <div>
            <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.sourceMode', 'Source Mode')}</dt>
            <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
              {event.source_mode === 'reference' ? t('events.sourceModeReference', 'Reference external folder') : t('events.sourceModeManaged', 'Managed (upload to PicPeak)')}
              {event.source_mode === 'reference' && event.external_path ? (
                <span className="text-neutral-500 dark:text-neutral-400 ml-2">/external-media/{event.external_path}</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.welcomeMessage')}</dt>
            <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
              {event.welcome_message || <span className="text-neutral-400">{t('events.noWelcomeMessageSet')}</span>}
            </dd>
          </div>

          <div>
            <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.hostName')}</dt>
            <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
              {event.customer_name || <span className="text-neutral-400">{t('common.notSet')}</span>}
            </dd>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.hostEmail')}</dt>
            <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">{event.customer_email}</dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.adminEmail')}</dt>
              <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">{event.admin_email}</dd>
            </div>
          </div>

          {phoneFieldEnabled && (
            <div>
              <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
                {t('events.customerPhone', 'Customer Phone')}
              </dt>
              <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                {event.customer_phone || (
                  <span className="text-neutral-400">{t('common.notSet')}</span>
                )}
              </dd>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.created')}</dt>
              <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                {event.created_at && format(safeParseDate(event.created_at)!, 'PP')}
              </dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.expires')}</dt>
              <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                {event.expires_at ? (
                  <>
                    {format(safeParseDate(event.expires_at)!, 'PP')}
                    {!event.is_archived && daysUntilExpiration !== null && daysUntilExpiration > 0 && (
                      <span className="text-neutral-500 dark:text-neutral-400 ml-1">
                        {t('events.daysLeft', { count: daysUntilExpiration })}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-neutral-500 dark:text-neutral-400">{t('events.neverExpires', 'Never')}</span>
                )}
              </dd>
            </div>
          </div>

          <div>
            <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.heroPhoto')}</dt>
            <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
              {event.hero_photo_id ? (
                <span className="text-accent">{t('events.heroPhotoSelected')}</span>
              ) : (
                <span className="text-neutral-400">{t('events.noHeroPhotoSelected')}</span>
              )}
            </dd>
          </div>

          <div>
            <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.userUploads')}</dt>
            <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
              {event.allow_user_uploads ? (
                <div className="space-y-1">
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-900/40 rounded">
                    {t('common.yes')}
                  </span>
                  {event.upload_category_id && (
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">
                      {t('events.uploadCategory')}: {categories.find(c => c.id === event.upload_category_id)?.name || 'N/A'}
                    </p>
                  )}
                </div>
              ) : (
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 rounded">
                  {t('common.no')}
                </span>
              )}
            </dd>
          </div>

          {/* Download Protection Display */}
          <div className="pt-3 mt-3 border-t border-neutral-200 dark:border-neutral-700">
            <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-2">
              <Shield className="w-4 h-4" />
              {t('events.downloadProtection', 'Download Protection')}
            </dt>
            <dd className="mt-2 text-sm text-neutral-900 dark:text-neutral-100">
              <div className="flex flex-wrap gap-2">
                <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded ${
                  event.protection_level === 'maximum' ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' :
                  event.protection_level === 'enhanced' ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300' :
                  event.protection_level === 'standard' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' :
                  'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
                }`}>
                  {event.protection_level || 'standard'}
                </span>
                {event.disable_right_click && (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                    <MousePointer className="w-3 h-3 mr-1" />
                    {t('events.rightClickBlocked', 'Right-click blocked')}
                  </span>
                )}
                {event.enable_devtools_protection && (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                    <Monitor className="w-3 h-3 mr-1" />
                    {t('events.devtoolsDetection', 'DevTools detection')}
                  </span>
                )}
                {!event.allow_downloads && (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded">
                    <Download className="w-3 h-3 mr-1" />
                    {t('events.downloadsDisabled', 'Downloads disabled')}
                  </span>
                )}
                {event.watermark_downloads && (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                    <Droplets className="w-3 h-3 mr-1" />
                    {t('events.watermarked', 'Watermarked')}
                  </span>
                )}
              </div>
            </dd>
          </div>

          {/* Hero Logo Settings Display */}
          <div className="pt-3 mt-3 border-t border-neutral-200 dark:border-neutral-700">
            <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-2">
              <Layout className="w-4 h-4" />
              {t('events.heroLogoSettings', 'Hero Logo Settings')}
            </dt>
            <dd className="mt-2 text-sm text-neutral-900 dark:text-neutral-100">
              <div className="flex flex-wrap gap-2">
                {event.hero_logo_visible !== false ? (
                  <>
                    <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 rounded">
                      <Image className="w-3 h-3 mr-1" />
                      {t('events.heroLogoVisibleLabel', 'Logo visible')}
                    </span>
                    <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                      {t('events.heroLogoSizeLabel', 'Size')}: {event.hero_logo_size || 'medium'}
                    </span>
                    <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                      {t('events.heroLogoPositionLabel', 'Position')}: {event.hero_logo_position || 'top'}
                    </span>
                  </>
                ) : (
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                    <Image className="w-3 h-3 mr-1" />
                    {t('events.heroLogoHidden', 'Logo hidden')}
                  </span>
                )}
              </div>
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
};
