import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { Trash2, Upload } from 'lucide-react';
import type { Event } from '../../../../types';
import { Loading, MarkdownContent } from '../../../../components/common';
import { FocalPointPicker, HeroPhotoSelector, ThemeCustomizerEnhanced, ThemeDisplay } from '../../../../components/admin';
import { api } from '../../../../config/api';
import { buildResourceUrl } from '../../../../utils/url';
import { usePublicSettings } from '../../../../hooks/usePublicSettings';
import { cssTemplatesService } from '../../../../services/cssTemplates.service';
import type { AdminPhoto } from '../../../../services/photos.service';
import { GALLERY_THEME_PRESETS, type ThemeConfig } from '../../../../types/theme.types';
import { SectionCard, checkboxClass, inputClass, labelClass, type FieldsProps } from './sections';

const selectClass = 'w-full px-3 py-2 border border-line-strong bg-panel text-heading rounded-md shadow-sm focus:ring-accent focus:border-accent-dark text-sm disabled:bg-inset';

const BannerOverride: React.FC<FieldsProps & { kind: 'promo' | 'info' }> = ({ f, set, kind }) => {
  const { t } = useTranslation();
  const modeKey = kind === 'promo' ? 'promo_mode' : 'info_mode';
  const textKey = kind === 'promo' ? 'promo_markdown' : 'info_markdown';
  const mode = f[modeKey];
  const text = f[textKey];
  return (
    <div className="pt-4 border-t border-line">
      <h4 className="text-sm font-semibold text-heading mb-1">
        {kind === 'promo' ? t('events.promoBanner.title', 'Promotional Banner') : t('events.infoBanner.title', 'Info Banner')}
      </h4>
      <p className="text-xs text-muted mb-3">
        {kind === 'promo'
          ? t('events.promoBanner.help', 'Choose how this gallery handles the promotional banner. "Inherit" uses your global default; "Custom" overrides it for this event; "Off" hides it entirely.')
          : t('events.infoBanner.help', 'A short note shown above the photos in this gallery. "Inherit" uses your global default; "Custom" overrides it for this event; "Off" hides it entirely.')}
      </p>
      <div className="flex flex-wrap gap-4">
        {(['inherit', 'custom', 'off'] as const).map((option) => (
          <label key={option} className="flex items-center">
            <input
              type="radio"
              name={modeKey}
              value={option}
              checked={mode === option}
              onChange={() => set({ [modeKey]: option })}
              className="w-4 h-4 text-accent border-line-strong focus:ring-accent"
            />
            <span className="ml-2 text-sm text-body">
              {kind === 'promo'
                ? t(`events.promoBanner.mode_${option}`, option === 'inherit' ? 'Inherit global default' : option === 'custom' ? 'Custom override for this event' : 'Off (hide for this event)')
                : t(`events.infoBanner.mode_${option}`, option === 'inherit' ? 'Inherit global default' : option === 'custom' ? 'Custom override for this event' : 'Off (hide for this event)')}
            </span>
          </label>
        ))}
      </div>
      {mode === 'custom' && (
        <div className="mt-3 space-y-2">
          <textarea
            value={text}
            onChange={(e) => set({ [textKey]: e.target.value })}
            rows={kind === 'promo' ? 5 : 3}
            placeholder={kind === 'promo'
              ? t('events.promoBanner.placeholder', 'Markdown content (e.g. **Special offer:** [book your next session](https://example.com))')
              : t('events.infoBanner.placeholder', 'Use the menu button in the top-left corner to filter the photos.')}
            className={`${inputClass} font-mono text-sm`}
          />
          {text.trim() && (
            <div className="border border-line rounded-lg p-3 bg-shell">
              <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('events.promoBanner.preview', 'Preview')}</p>
              <MarkdownContent source={text} className="prose prose-sm dark:prose-invert max-w-none text-sm text-body prose-a:text-accent" />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Logo uploads are files, not settings: they take effect on upload, as they
 * always have, and need no Save.
 */
const EventLogoUpload: React.FC<{ event: Event; disabled: boolean }> = ({ event, disabled }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async (request: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(true);
    try {
      await request();
      toast.success(success);
      queryClient.invalidateQueries({ queryKey: ['admin-event', String(event.id)] });
    } catch (error: unknown) {
      const e = error as { response?: { data?: { error?: string } } };
      toast.error(e?.response?.data?.error || failure);
    } finally {
      setBusy(false);
    }
  };

  const upload = (file: File) => {
    const formData = new FormData();
    formData.append('logo', file);
    return run(
      () => api.post(`/admin/events/${event.id}/logo`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
      t('events.eventLogoUploaded', 'Event logo uploaded successfully'),
      t('events.eventLogoUploadFailed', 'Failed to upload event logo'),
    );
  };

  const fileInput = (
    <input
      type="file"
      className="hidden"
      accept="image/png,image/jpeg,image/gif,image/svg+xml"
      disabled={busy || disabled}
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) upload(file);
        e.target.value = '';
      }}
    />
  );

  return (
    <div>
      <label className={labelClass}>{t('events.eventCustomLogo', 'Custom Event Logo')}</label>
      <p className="text-xs text-muted mb-2">
        {t('events.eventCustomLogoDescription', 'Upload a custom logo for this event. This overrides the global branding logo for this gallery only.')}
      </p>
      {event.hero_logo_url ? (
        <div className="flex items-center gap-3">
          <div className="w-16 h-16 border border-line rounded-md flex items-center justify-center bg-inset overflow-hidden">
            <img src={buildResourceUrl(event.hero_logo_url)} alt={t('events.eventCustomLogo', 'Custom Event Logo')} className="max-w-full max-h-full object-contain" />
          </div>
          {!disabled && (
            <div className="flex flex-col gap-1">
              <label className="cursor-pointer inline-flex items-center gap-1 text-xs text-accent hover:opacity-80">
                <Upload className="w-3 h-3" />
                {t('events.replaceLogo', 'Replace')}
                {fileInput}
              </label>
              <button
                type="button"
                onClick={() => run(
                  () => api.delete(`/admin/events/${event.id}/logo`),
                  t('events.eventLogoRemoved', 'Event logo removed successfully'),
                  t('events.eventLogoRemoveFailed', 'Failed to remove event logo'),
                )}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs text-danger-text"
              >
                <Trash2 className="w-3 h-3" />
                {t('events.removeLogo', 'Remove')}
              </button>
            </div>
          )}
          {busy && <Loading size="sm" />}
        </div>
      ) : !disabled ? (
        <div className="flex items-center gap-2">
          <label className={`cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-line-strong text-body rounded-md hover:bg-hover ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
            <Upload className="w-3.5 h-3.5" />
            {t('events.uploadEventLogo', 'Upload Logo')}
            {fileInput}
          </label>
          {busy && <Loading size="sm" />}
        </div>
      ) : null}
    </div>
  );
};

export const AppearanceSection: React.FC<FieldsProps & {
  event: Event;
  photos: AdminPhoto[];
  readOnly: boolean;
}> = ({ f, set, event, photos, readOnly }) => {
  const { t } = useTranslation();
  const { data: publicSettings } = usePublicSettings();
  const branding = (publicSettings?.theme_config as ThemeConfig | undefined) ?? null;
  const { data: cssTemplates = [] } = useQuery({
    queryKey: ['css-templates-enabled'],
    queryFn: () => cssTemplatesService.getEnabledTemplates(),
    enabled: f.custom_theme_enabled,
  });
  const [presetName, setPresetName] = useState('custom');

  const heroPhoto = photos.find((p) => p.id === f.hero_photo_id);
  const heroImageUrl = heroPhoto?.thumbnail_url || heroPhoto?.url;

  const toggleCustom = () => {
    // The first switch-on starts from Branding, so nothing changes until the
    // admin edits something.
    const next = !f.custom_theme_enabled;
    set(next && !event.color_theme
      ? { custom_theme_enabled: true, theme: branding ?? GALLERY_THEME_PRESETS.default.config }
      : { custom_theme_enabled: next });
  };

  return (
    <>
      <SectionCard title={t('events.settingsTab.heroLogoBanners', 'Hero, logo & banners')}>
        <HeroPhotoSelector
          photos={photos}
          currentHeroPhotoId={f.hero_photo_id}
          onSelect={(photoId) => set({ hero_photo_id: photoId })}
          isEditing={!readOnly}
        />
        {/* Per-event social-share opt-in (#474); needs a hero to show. */}
        <label className={`flex items-start gap-2 ${f.hero_photo_id ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}>
          <input
            type="checkbox"
            className="mt-0.5 rounded border-line-strong text-accent focus:ring-accent"
            checked={f.og_image_share_enabled === true}
            disabled={!f.hero_photo_id}
            onChange={(e) => set({ og_image_share_enabled: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium text-heading">{t('events.ogShare.title', 'Use hero photo as social-share preview')}</span>
            <span className="block text-xs text-soft mt-0.5">
              {f.hero_photo_id
                ? t('events.ogShare.help', 'When this gallery URL is shared on WhatsApp, Facebook, Slack, etc., the link preview will show the hero photo above. The thumbnail is fetched unauthenticated by link-preview crawlers — anyone with the URL effectively makes this image public. Off by default; pick a hero you are comfortable surfacing publicly before enabling.')
                : t('events.ogShare.heroRequired', 'Pick a hero photo above first — this option uses it as the WhatsApp / Facebook / Slack preview image.')}
            </span>
          </span>
        </label>
        {f.hero_photo_id && heroImageUrl && (
          <div>
            <label className={labelClass}>{t('events.heroImageAnchor', 'Hero Image Crop Position')}</label>
            <p className="text-xs text-muted mb-2">{t('events.heroImageAnchorDescription', 'Click on the image to set the focal point for cropping.')}</p>
            <FocalPointPicker
              imageUrl={heroImageUrl}
              currentValue={f.hero_image_anchor}
              onChange={(value) => set({ hero_image_anchor: value })}
              slug={event.slug}
            />
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-line">
          <div>
            <label className={labelClass}>{t('events.heroLogoVisible', 'Display logo in hero section')}</label>
            <select
              // Tri-state (#756): inherit = null = follow Branding.
              value={f.hero_logo_visible === null ? 'inherit' : f.hero_logo_visible ? 'show' : 'hide'}
              onChange={(e) => set({ hero_logo_visible: e.target.value === 'inherit' ? null : e.target.value === 'show' })}
              className={selectClass}
            >
              <option value="inherit">{t('events.heroLogoInherit', 'Use branding default')}</option>
              <option value="show">{t('events.heroLogoShow', 'Always show')}</option>
              <option value="hide">{t('events.heroLogoHide', 'Always hide')}</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>{t('events.loginLogoVisible', 'Display logo on password page')}</label>
            <select
              // #894: null keeps the default (show); false hides it.
              value={f.login_logo_visible === false ? 'hide' : 'show'}
              onChange={(e) => set({ login_logo_visible: e.target.value === 'hide' ? false : null })}
              className={selectClass}
            >
              <option value="show">{t('events.loginLogoShow', 'Show (default)')}</option>
              <option value="hide">{t('events.loginLogoHide', 'Hide')}</option>
            </select>
          </div>
          {f.hero_logo_visible !== false && (
            <>
              <div>
                <label className={labelClass}>{t('events.heroLogoSize', 'Logo Size')}</label>
                <select
                  // '' = inherit the global branding logo size (#756).
                  value={f.hero_logo_size ?? ''}
                  onChange={(e) => set({ hero_logo_size: e.target.value === '' ? null : e.target.value as 'small' | 'medium' | 'large' | 'xlarge' })}
                  className={selectClass}
                >
                  <option value="">{t('events.heroLogoInherit', 'Use branding default')}</option>
                  <option value="small">{t('events.heroLogoSizeSmall', 'Small')}</option>
                  <option value="medium">{t('events.heroLogoSizeMedium', 'Medium')}</option>
                  <option value="large">{t('events.heroLogoSizeLarge', 'Large')}</option>
                  <option value="xlarge">{t('events.heroLogoSizeXLarge', 'Extra Large')}</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>{t('events.heroLogoPosition', 'Logo Position')}</label>
                <select
                  value={f.hero_logo_position}
                  onChange={(e) => set({ hero_logo_position: e.target.value as 'top' | 'center' | 'bottom' })}
                  className={selectClass}
                >
                  <option value="top">{t('events.heroLogoPositionTop', 'Top (above title)')}</option>
                  <option value="center">{t('events.heroLogoPositionCenter', 'Center (between title and dates)')}</option>
                  <option value="bottom">{t('events.heroLogoPositionBottom', 'Bottom (below dates)')}</option>
                </select>
              </div>
            </>
          )}
        </div>
        {f.hero_logo_visible !== false && <EventLogoUpload event={event} disabled={readOnly} />}

        <BannerOverride f={f} set={set} kind="info" />
        <BannerOverride f={f} set={set} kind="promo" />
      </SectionCard>

      <SectionCard title={t('events.settingsTab.customStyling', 'Custom gallery styling')}>
        <div className="flex items-start gap-4">
          <p className="text-sm text-soft flex-1">
            {t('events.settingsTab.customStylingHelp', 'Off: this gallery uses the global theme from Branding and follows every change made there. On: override the layout, header, controls, colours, fonts, CSS template and custom CSS for this gallery only.')}
          </p>
          <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
            <input
              type="checkbox"
              role="switch"
              className={checkboxClass}
              checked={f.custom_theme_enabled}
              onChange={toggleCustom}
              aria-label={t('events.settingsTab.customStyling', 'Custom gallery styling')}
            />
            <span className="text-sm font-medium text-body">
              {f.custom_theme_enabled ? t('common.on', 'on') : t('common.off', 'off')}
            </span>
          </label>
        </div>
        {f.custom_theme_enabled ? (
          <div className="space-y-3">
            <ThemeCustomizerEnhanced
              value={f.theme}
              forceColorMode={publicSettings?.branding_force_color_mode ?? null}
              onChange={(theme) => { setPresetName('custom'); set({ theme }); }}
              presetName={presetName}
              onPresetChange={(name) => {
                setPresetName(name);
                const preset = GALLERY_THEME_PRESETS[name];
                if (preset) set({ theme: preset.config });
              }}
              onSyncFromBranding={() => {
                if (!branding) {
                  toast.error(t('toast.brandingThemeMissing', 'No branding theme has been saved yet.'));
                  return;
                }
                set({ theme: { ...branding } });
                setPresetName('custom');
                toast.success(t('events.settingsTab.copiedBranding', 'Copied the global theme. Save to keep it.'));
              }}
              showGalleryLayouts={true}
              hideActions={true}
              cssTemplates={cssTemplates}
              cssTemplateId={f.css_template_id}
              onCssTemplateChange={(css_template_id) => set({ css_template_id })}
            />
            <p className="text-xs text-muted">
              {t('events.settingsTab.customStylingKept', 'Switching this off keeps these values, so switching it on again restores them.')}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-subtle p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="text-sm font-semibold text-heading">{t('events.settingsTab.globalTheme', 'Global theme (Branding)')}</span>
              <Link to="/admin/settings?tab=branding" className="text-sm font-medium text-accent hover:underline">
                {t('events.settingsTab.editGlobalTheme', 'Edit global theme')}
              </Link>
            </div>
            <ThemeDisplay theme={branding ?? GALLERY_THEME_PRESETS.default.config} showDetails={true} />
          </div>
        )}
      </SectionCard>
    </>
  );
};
