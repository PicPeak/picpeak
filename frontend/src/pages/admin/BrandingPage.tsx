import React, { useState, useEffect, useRef } from 'react';
import { Save, Eye, Palette, Upload } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card, Input, ErrorBoundary, Loading, MarkdownContent } from '../../components/common';
import { ThemeCustomizerEnhanced, GalleryPreview } from '../../components/admin';
import { useTheme, type ThemeConfig, GALLERY_THEME_PRESETS } from '../../contexts/ThemeContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsService, type BrandingSettings } from '../../services/settings.service';
import { businessProfileService } from '../../services/businessProfile.service';
import { useTranslation } from 'react-i18next';
import { buildResourceUrl } from '../../utils/url';
import { useFeatureEnabled, useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { CustomerDashboardBrandingCard } from '../../components/admin/CustomerDashboardBrandingCard';
import { PdfTypographyCard } from '../../components/admin/PdfTypographyCard';
import { usePublicSettings } from '../../hooks/usePublicSettings';

export const BrandingPage: React.FC = () => {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  // Used to gate the PDF typography card — when no PDF-producing
  // feature is enabled the setting has no surface to apply to.
  const { flags } = useFeatureFlags();
  const [brandingSettings, setBrandingSettings] = useState<BrandingSettings>({
    company_name: '',
    company_tagline: '',
    footer_text: '',
    support_email: '',
    watermark_enabled: false,
    watermark_position: 'bottom-right',
    watermark_opacity: 50,
    watermark_size: 15,
    watermark_logo_url: '',
    favicon_url: '',
    logo_url: '',
    logo_size: 'medium',
    logo_max_height: 48,
    logo_position: 'left',
    logo_display_header: true,
    logo_display_hero: true,
    logo_display_mode: 'logo_and_text',
    hide_powered_by: false,
    force_color_mode: null,
    login_logo_frame_enabled: true,
    login_logo_size: 'medium',
    facebook_url: '',
    instagram_url: '',
    whatsapp_url: '',
    twitter_url: '',
    youtube_url: '',
    promo_markdown: '',
    promo_position: 'above_footer',
    promo_alignment: 'center',
  });

  const [currentTheme, setCurrentTheme] = useState<ThemeConfig>(theme);
  const [currentThemeName, setCurrentThemeName] = useState('default');
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  // PDF body font selection (migration 121). Lives on this page so the
  // top-level Save button can persist it together with branding +
  // theme — no card-local save button. Null = "no preference,
  // fall back to Helvetica" — same encoding the column uses.
  const [pdfFontFamily, setPdfFontFamily] = useState<string | null>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);

  // Fetch current settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin-settings', 'branding'],
    queryFn: () => settingsService.getSettingsByType('branding'),
  });

  // Fetch theme settings
  const { data: themeSettings } = useQuery({
    queryKey: ['admin-settings', 'theme'],
    queryFn: () => settingsService.getSettingsByType('theme'),
  });

  // Fetch business profile snapshot — needed to hydrate the PDF
  // typography card with the saved pdfFontFamily value. The PDF
  // typography card is rendered only when a PDF-producing feature is
  // enabled, but the query is cheap and the page already issues other
  // settings queries on mount, so we always fetch.
  const { data: businessProfileSnapshot } = useQuery({
    queryKey: ['business-profile-snapshot'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60 * 1000,
  });

  // Update branding mutation
  const queryClient = useQueryClient();
  
  const brandingMutation = useMutation({
    mutationFn: settingsService.updateBranding,
    onSuccess: () => {
      toast.success(t('toast.brandingUpdated'));
      // Invalidate all settings queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    },
  });

  // Update theme mutation
  const themeMutation = useMutation({
    mutationFn: settingsService.updateTheme,
    onSuccess: () => {
      toast.success(t('toast.themeUpdated'));
      // Refresh both the admin settings cache (which the page reads from) and
      // the public-settings cache (which the gallery reads from) so the saved
      // theme is reflected without a manual reload (#317).
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    },
  });

  // Initialize settings from database
  useEffect(() => {
    if (settings) {
      const formatted = settingsService.formatBrandingSettings(settings);
      // Include logo_url from branding settings
      setBrandingSettings(prev => ({ ...prev, ...formatted }));
    }
  }, [settings]);

  // Hydrate the PDF font selection once the business profile arrives.
  useEffect(() => {
    if (businessProfileSnapshot?.profile) {
      setPdfFontFamily(businessProfileSnapshot.profile.pdfFontFamily || null);
    }
  }, [businessProfileSnapshot?.profile?.pdfFontFamily]);

  // Initialize theme from database
  useEffect(() => {
    if (themeSettings) {
      const formatted = settingsService.formatThemeSettings(themeSettings) as ThemeConfig;

      if (formatted && Object.keys(formatted).length > 0) {
        // Use the theme's logo URL as stored in the theme config
        setCurrentTheme(formatted);
        setTheme(formatted);

        // Only sync logo URL from theme if it exists there (logo is stored in branding settings)
        if (formatted.logoUrl) {
          setBrandingSettings(prev => ({ ...prev, logo_url: formatted.logoUrl }));
        }

        // Try to identify which preset this matches. Compare only on the
        // fields the preset itself defines so saved themes carrying extras
        // like a `logoUrl` (preserved through preset changes — see
        // handlePresetChange) still match the original preset shape.
        for (const [key, preset] of Object.entries(GALLERY_THEME_PRESETS)) {
          const keys = Object.keys(preset.config);
          const matches = keys.every((k) =>
            JSON.stringify((preset.config as any)[k]) === JSON.stringify((formatted as any)[k])
          );
          if (matches) {
            setCurrentThemeName(key);
            break;
          }
        }
      }
    }
  }, [themeSettings, setTheme]);

  const handleBrandingChange = (key: string, value: any) => {
    setBrandingSettings(prev => ({ ...prev, [key]: value }));
  };

  /**
   * Force color mode is the only branding setting that auto-saves on click —
   * users expect a toggle that takes effect immediately, not a setting they
   * have to remember to click "Save" for. We keep all other branding fields
   * on the bulk-save flow because typing in a text input shouldn't trigger
   * a network round-trip per keystroke. Auto-save here invalidates the
   * public-settings query so AdminDarkModeContext reapplies live without
   * waiting for its 30-second poll.
   */
  const handleForceColorModeChange = (value: 'dark' | 'light' | null) => {
    const next = { ...brandingSettings, force_color_mode: value };
    setBrandingSettings(next);
    brandingMutation.mutate(next);
  };

  const handleThemeChange = (newTheme: ThemeConfig) => {
    // Preset configs don't carry a logoUrl or customCss, so a preset change
    // inside the customizer arrives here with those fields undefined. Keep
    // the existing values instead of wiping the persisted ones on save
    // (#317 for logoUrl, #645 for customCss).
    const mergedTheme: ThemeConfig = {
      ...newTheme,
      logoUrl: newTheme.logoUrl ?? currentTheme.logoUrl,
      customCss: newTheme.customCss ?? currentTheme.customCss
    };
    setCurrentTheme(mergedTheme);
    if (newTheme.logoUrl !== undefined && newTheme.logoUrl !== currentTheme.logoUrl) {
      setBrandingSettings(prev => ({ ...prev, logo_url: newTheme.logoUrl || '' }));
    }
    if (isPreviewMode) {
      setTheme(mergedTheme);
    }
  };

  const handlePresetChange = (presetName: string) => {
    setCurrentThemeName(presetName);
    // Get the preset theme config
    const preset = GALLERY_THEME_PRESETS[presetName];
    if (preset) {
      // Preserve the existing logo + custom CSS when switching presets
      // (#317 for logo, #645 for customCss). Presets define a look; they
      // shouldn't silently drop the admin's persisted styling extras.
      setCurrentTheme(prev => ({
        ...preset.config,
        logoUrl: prev.logoUrl,
        customCss: prev.customCss
      }));
      if (isPreviewMode) {
        setTheme({
          ...preset.config,
          logoUrl: currentTheme.logoUrl,
          customCss: currentTheme.customCss
        });
      }
    }
  };

  const handleFaviconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const faviconUrl = await settingsService.uploadFavicon(file);
        setBrandingSettings(prev => ({ ...prev, favicon_url: faviconUrl }));
        toast.success(t('toast.uploadSuccess'));
      } catch (error) {
        console.error('Failed to upload favicon:', error);
        toast.error(t('toast.uploadError'));
      }
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const logoUrl = await settingsService.uploadLogo(file);
        setBrandingSettings(prev => ({ ...prev, logo_url: logoUrl }));
        setCurrentTheme(prev => {
          const updated = { ...prev, logoUrl };
          if (isPreviewMode) {
            setTheme(updated);
          }
          return updated;
        });
        toast.success(t('toast.uploadSuccess'));
      } catch (error) {
        console.error('Failed to upload logo:', error);
        toast.error(t('toast.uploadError'));
      }
    }
  };

  const handleRemoveLogo = () => {
    setBrandingSettings(prev => ({ ...prev, logo_url: '' }));
    setCurrentTheme(prev => {
      const updated = { ...prev, logoUrl: '' };
      if (isPreviewMode) {
        setTheme(updated);
      }
      return updated;
    });
  };

  // Dark-mode logo — self-contained (the upload endpoint persists
  // branding_logo_url_dark directly; not part of the theme payload).
  // Consumers (admin header, gallery) pick it when the theme is dark.
  const { data: pubSettings } = usePublicSettings();
  const [logoDarkUrl, setLogoDarkUrl] = useState('');
  useEffect(() => {
    if (pubSettings?.branding_logo_url_dark !== undefined) {
      setLogoDarkUrl(pubSettings.branding_logo_url_dark || '');
    }
  }, [pubSettings?.branding_logo_url_dark]);

  const refreshSettings = () => {
    queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
  };

  const handleDarkLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await settingsService.uploadLogo(file, 'dark');
      setLogoDarkUrl(url);
      refreshSettings();
      toast.success(t('toast.uploadSuccess'));
    } catch (error) {
      console.error('Failed to upload dark logo:', error);
      toast.error(t('toast.uploadError'));
    }
  };

  const handleRemoveDarkLogo = async () => {
    try {
      await settingsService.removeLogo('dark');
      setLogoDarkUrl('');
      refreshSettings();
    } catch (error) {
      console.error('Failed to remove dark logo:', error);
      toast.error(t('toast.saveError'));
    }
  };

  const handleWatermarkLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const watermarkLogoUrl = await settingsService.uploadWatermarkLogo(file);
        setBrandingSettings(prev => ({ ...prev, watermark_logo_url: watermarkLogoUrl }));
        toast.success(t('toast.uploadSuccess'));
      } catch (error) {
        console.error('Failed to upload watermark logo:', error);
        toast.error(t('toast.uploadError'));
      }
    }
  };

  const handleSave = async () => {
    try {
      // Sync logo URL from theme to branding settings, but never let an
      // undefined/empty theme.logoUrl wipe a logo that is still configured in
      // branding settings (#317 — preset selection does not imply logo removal).
      const updatedBrandingSettings = {
        ...brandingSettings,
        logo_url: currentTheme.logoUrl || brandingSettings.logo_url || ''
      };

      // Save branding settings to database
      await brandingMutation.mutateAsync(updatedBrandingSettings);

      // Save theme settings to database
      await themeMutation.mutateAsync(currentTheme);

      // Persist PDF font family if it changed. Skipped when the value
      // matches the snapshot to avoid touching business_profile on
      // every Branding save (the row carries unrelated settings).
      const savedPdfFontFamily = businessProfileSnapshot?.profile?.pdfFontFamily || null;
      if (savedPdfFontFamily !== pdfFontFamily) {
        await businessProfileService.update({
          pdfFontFamily: pdfFontFamily ? pdfFontFamily : null,
        });
        queryClient.invalidateQueries({ queryKey: ['business-profile-snapshot'] });
      }

      // Apply theme globally
      setTheme(currentTheme);

      // Update local state to reflect saved values
      setBrandingSettings(updatedBrandingSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  };

  const handlePreview = () => {
    const previewWindow = window.open('/gallery/preview', '_blank');
    if (previewWindow) {
      // Send theme data to preview window
      setTimeout(() => {
        previewWindow.postMessage({
          type: 'THEME_PREVIEW',
          theme: currentTheme,
          branding: brandingSettings
        }, window.location.origin);
      }, 1000);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('branding.loadingBranding')} />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div>
        {/* Page Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('branding.title')}</h1>
            <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('branding.subtitle')}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              leftIcon={<Eye className="w-4 h-4" />}
              onClick={handlePreview}
            >
              {t('branding.preview')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Save className="w-4 h-4" />}
              onClick={handleSave}
            >
              {t('branding.saveChanges')}
            </Button>
          </div>
        </div>

        {/* Company Branding */}
        <Card padding="md" className="mb-6">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('branding.companyInfo')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Input
              label={t('branding.companyName')}
              value={brandingSettings.company_name}
              onChange={(e) => handleBrandingChange('company_name', e.target.value)}
              placeholder={t('branding.companyName')}
              helperText={t('branding.companyNameHelp')}
            />
            <Input
              label={t('branding.companyTagline')}
              value={brandingSettings.company_tagline}
              onChange={(e) => handleBrandingChange('company_tagline', e.target.value)}
              placeholder={t('branding.companyTagline')}
              helperText={t('branding.companyTaglineHelp')}
            />
            <Input
              label={t('branding.supportEmail')}
              type="email"
              value={brandingSettings.support_email}
              onChange={(e) => handleBrandingChange('support_email', e.target.value)}
              placeholder="support@yourcompany.com"
              helperText={t('branding.supportEmailHelp')}
            />
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.footerText')}
              </label>
              <textarea
                value={brandingSettings.footer_text}
                onChange={(e) => handleBrandingChange('footer_text', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                rows={2}
                placeholder={`© ${new Date().getFullYear()} Your Company. All rights reserved.`}
              />
            </div>
          </div>

          {/* Social media links (#441) — appear as icons in the gallery
              footer above the legal-links row. Empty = hidden. */}
          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
              {t('branding.socialMedia.title', 'Social Media')}
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
              {t('branding.socialMedia.help', 'Add URLs to render social-media icons in the gallery footer. Leave a field empty to hide that icon.')}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label="Facebook"
                type="url"
                value={brandingSettings.facebook_url || ''}
                onChange={(e) => handleBrandingChange('facebook_url', e.target.value)}
                placeholder="https://facebook.com/yourstudio"
              />
              <Input
                label="Instagram"
                type="url"
                value={brandingSettings.instagram_url || ''}
                onChange={(e) => handleBrandingChange('instagram_url', e.target.value)}
                placeholder="https://instagram.com/yourstudio"
              />
              <Input
                label="WhatsApp"
                type="text"
                value={brandingSettings.whatsapp_url || ''}
                onChange={(e) => handleBrandingChange('whatsapp_url', e.target.value)}
                placeholder="https://wa.me/491234567890 or +491234567890"
                helperText={t('branding.socialMedia.whatsappHelp', 'A wa.me URL or a phone number with country code (will be converted).')}
              />
              <Input
                label="X / Twitter"
                type="url"
                value={brandingSettings.twitter_url || ''}
                onChange={(e) => handleBrandingChange('twitter_url', e.target.value)}
                placeholder="https://x.com/yourstudio"
              />
              <Input
                label="YouTube"
                type="url"
                value={brandingSettings.youtube_url || ''}
                onChange={(e) => handleBrandingChange('youtube_url', e.target.value)}
                placeholder="https://youtube.com/@yourstudio"
              />
            </div>
          </div>

          {/* Promotional banner (#440) — markdown content rendered above
              or below the gallery footer. Per-event override is set on
              the Edit Event form; this is the global default. */}
          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
              {t('branding.promo.title', 'Gallery Promotional Banner')}
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
              {t('branding.promo.help', 'Markdown shown above or below the gallery footer (e.g. seasonal offer, print discount). Per-event overrides take priority.')}
            </p>
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.promo.position', 'Position')}
                  </label>
                  <select
                    value={brandingSettings.promo_position || 'above_footer'}
                    onChange={(e) => handleBrandingChange('promo_position', e.target.value as 'above_footer' | 'below_footer')}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="above_footer">{t('branding.promo.aboveFooter', 'Above footer')}</option>
                    <option value="below_footer">{t('branding.promo.belowFooter', 'Below footer')}</option>
                  </select>
                </div>
                {/* Horizontal alignment (#482). Defaults to center
                    so the banner aligns with the gallery footer. */}
                <div className="flex-1">
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.promo.alignment', 'Alignment')}
                  </label>
                  <select
                    value={brandingSettings.promo_alignment || 'center'}
                    onChange={(e) => handleBrandingChange('promo_alignment', e.target.value as 'left' | 'center' | 'right')}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="left">{t('branding.promo.alignLeft', 'Left')}</option>
                    <option value="center">{t('branding.promo.alignCenter', 'Center (default — matches footer)')}</option>
                    <option value="right">{t('branding.promo.alignRight', 'Right')}</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.promo.content', 'Content (markdown)')}
                </label>
                <textarea
                  value={brandingSettings.promo_markdown || ''}
                  onChange={(e) => handleBrandingChange('promo_markdown', e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 font-mono text-sm"
                  rows={5}
                  placeholder={t('branding.promo.placeholder', '**Spring offer**: 20% off prints with code SPRING — see the [print shop](https://example.com).')}
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {t('branding.promo.markdownHelp', 'Bold, italic, links, lists, and headings supported. HTML is stripped.')}
                </p>
              </div>
              {brandingSettings.promo_markdown && brandingSettings.promo_markdown.trim() && (
                <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 bg-neutral-50 dark:bg-neutral-800/40">
                  <div className="text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
                    {t('branding.promo.preview', 'Preview')}
                  </div>
                  {/* Preview mirrors the live gallery render — same
                      alignment class so the admin sees what guests
                      will see (#482). */}
                  <MarkdownContent
                    source={brandingSettings.promo_markdown}
                    className={`text-sm text-neutral-800 dark:text-neutral-200 prose prose-sm prose-a:text-primary-600 dark:prose-a:text-primary-400 ${
                      brandingSettings.promo_alignment === 'left' ? 'text-left'
                        : brandingSettings.promo_alignment === 'right' ? 'text-right'
                        : 'text-center'
                    }`}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.favicon')}
              </label>
              <div className="space-y-2">
                {brandingSettings.favicon_url && (
                  <div className="flex items-center gap-2">
                    <img 
                      src={brandingSettings.favicon_url.startsWith('http') ? brandingSettings.favicon_url : buildResourceUrl(brandingSettings.favicon_url)} 
                      alt="Current favicon" 
                      className="w-8 h-8"
                    />
                    <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('branding.currentFavicon')}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleBrandingChange('favicon_url', '')}
                    >
                      {t('branding.removeFavicon')}
                    </Button>
                  </div>
                )}
                <div>
                  <input
                    ref={faviconInputRef}
                    type="file"
                    accept="image/png,image/x-icon"
                    onChange={handleFaviconUpload}
                    className="hidden"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => faviconInputRef.current?.click()}
                    leftIcon={<Upload className="w-4 h-4" />}
                  >
                    {t('branding.uploadFavicon')}
                  </Button>
                  <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{t('branding.faviconHelp')}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Logo Customization Settings */}
          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-md font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('branding.logoCustomization', 'Logo Customization')}</h3>

            <div className="space-y-4">
              {/* Logo Upload */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.logo', 'Logo')}
                </label>
                <div className="flex items-center gap-4">
                  {brandingSettings.logo_url && (
                    <div className="relative">
                      <img 
                        src={brandingSettings.logo_url.startsWith('http') ? brandingSettings.logo_url : buildResourceUrl(brandingSettings.logo_url)} 
                        alt="Logo"
                        className="h-16 object-contain bg-neutral-100 dark:bg-neutral-700 rounded p-2"
                      />
                      <button
                        type="button"
                        onClick={handleRemoveLogo}
                        className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <div>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml"
                      onChange={handleLogoUpload}
                      className="hidden"
                      id="logo-upload"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => document.getElementById('logo-upload')?.click()}
                      leftIcon={<Upload className="w-4 h-4" />}
                    >
                      {brandingSettings.logo_url ? t('branding.changeLogo', 'Change Logo') : t('branding.uploadLogo', 'Upload Logo')}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                  {t('branding.logoHelp', 'PNG, JPG or SVG format, recommended width: 200px')}
                </p>
              </div>
              {/* Dark-mode logo */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.logoDark', 'Dark-mode logo')}
                </label>
                <div className="flex items-center gap-4">
                  {logoDarkUrl && (
                    <div className="relative">
                      <img
                        src={logoDarkUrl.startsWith('http') ? logoDarkUrl : buildResourceUrl(logoDarkUrl)}
                        alt="Dark logo"
                        className="h-16 object-contain bg-neutral-800 rounded p-2"
                      />
                      <button
                        type="button"
                        onClick={handleRemoveDarkLogo}
                        className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <div>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml"
                      onChange={handleDarkLogoUpload}
                      className="hidden"
                      id="logo-dark-upload"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => document.getElementById('logo-dark-upload')?.click()}
                      leftIcon={<Upload className="w-4 h-4" />}
                    >
                      {logoDarkUrl ? t('branding.changeLogo', 'Change Logo') : t('branding.uploadLogo', 'Upload Logo')}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                  {t('branding.logoDarkHelp', 'Optional. Shown on dark themes / dark mode; falls back to the main logo when unset.')}
                </p>
              </div>
              {/* Logo Size */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.logoSize', 'Logo Size')}
                </label>
                <select
                  value={brandingSettings.logo_size || 'medium'}
                  onChange={(e) => handleBrandingChange('logo_size', e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                >
                  <option value="small">{t('branding.logoSizeSmall', 'Small (32px)')}</option>
                  <option value="medium">{t('branding.logoSizeMedium', 'Medium (48px)')}</option>
                  <option value="large">{t('branding.logoSizeLarge', 'Large (64px)')}</option>
                  <option value="xlarge">{t('branding.logoSizeXLarge', 'Extra Large (96px)')}</option>
                  <option value="custom">{t('branding.logoSizeCustom', 'Custom')}</option>
                </select>
              </div>

              {/* Custom Height (only shown when size is custom) */}
              {brandingSettings.logo_size === 'custom' && (
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.logoMaxHeight', 'Maximum Height (pixels)')}
                  </label>
                  <input
                    type="number"
                    min="20"
                    max="200"
                    value={brandingSettings.logo_max_height || 48}
                    onChange={(e) => handleBrandingChange('logo_max_height', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                  />
                  <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                    {t('branding.logoMaxHeightHelp', 'Set a custom maximum height for the logo (20-200 pixels)')}
                  </p>
                </div>
              )}

              {/* Logo Position
                  - left / center / right: position inside the gallery header bar.
                  - sidepanel: moves the logo out of the gallery header
                    and into the admin sidebar's brand row (replaces the
                    "PicPeak Admin" text; the favicon takes over when
                    the sidebar is collapsed). The gallery falls back
                    to 'left' for its own rendering. */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.logoPosition', 'Logo Position in Header')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {(['sidepanel', 'left', 'center', 'right'] as const).map((position) => (
                    <button
                      key={position}
                      type="button"
                      onClick={() => handleBrandingChange('logo_position', position)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        brandingSettings.logo_position === position
                          ? 'bg-accent-dark text-white'
                          : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600'
                      }`}
                    >
                      {t(`branding.position${position.charAt(0).toUpperCase() + position.slice(1)}`, position.charAt(0).toUpperCase() + position.slice(1))}
                    </button>
                  ))}
                </div>
                {brandingSettings.logo_position === 'sidepanel' && (
                  <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-2">
                    {t('branding.positionSidepanelHelp',
                      'The logo appears in the admin sidebar instead of the header. When the sidebar is collapsed, the favicon is shown.')}
                  </p>
                )}
              </div>

              {/* Display Mode */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.logoDisplayMode', 'Display Mode')}
                </label>
                <select
                  value={brandingSettings.logo_display_mode || 'logo_and_text'}
                  onChange={(e) => handleBrandingChange('logo_display_mode', e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                >
                  <option value="logo_only">{t('branding.logoOnly', 'Logo Only')}</option>
                  <option value="text_only">{t('branding.textOnly', 'Company Name Only')}</option>
                  <option value="logo_and_text">{t('branding.logoAndText', 'Logo and Company Name')}</option>
                </select>
              </div>

              {/* Display Options */}
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={brandingSettings.logo_display_header !== false}
                    onChange={(e) => handleBrandingChange('logo_display_header', e.target.checked)}
                    className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('branding.showLogoInHeader', 'Show logo in gallery header')}
                    </span>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">
                      {t('branding.showLogoInHeaderHelp', 'Display the logo in the main header bar')}
                    </p>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={brandingSettings.logo_display_hero !== false}
                    onChange={(e) => handleBrandingChange('logo_display_hero', e.target.checked)}
                    className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {t('branding.showLogoInHero', 'Show logo in hero section')}
                    </span>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400">
                      {t('branding.showLogoInHeroHelp', 'Display the logo in hero sections (for non-grid layouts)')}
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Login-page-only logo controls (#354 follow-up). These do
             NOT affect gallery/admin headers — those keep their own
             logo_size knob above. */}
          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-md font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
              {t('branding.loginLogo.title', 'Login pages logo')}
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
              {t('branding.loginLogo.subtitle', 'Controls only /admin/login and /customer/login. Gallery and admin chrome use the logo settings above.')}
            </p>

            <div className="space-y-4">
              {/* Frame toggle */}
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={brandingSettings.login_logo_frame_enabled !== false}
                  onChange={(e) => handleBrandingChange('login_logo_frame_enabled', e.target.checked)}
                  className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                />
                <div>
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {t('branding.loginLogo.frame', 'Show tinted frame behind the logo')}
                  </span>
                  <p className="text-xs text-neutral-600 dark:text-neutral-400">
                    {t(
                      'branding.loginLogo.frameHelp',
                      'When off, the logo sits directly on the page background. Useful for logos that already include their own backdrop.',
                    )}
                  </p>
                </div>
              </label>

              {/* Size selector */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.loginLogo.size', 'Logo size on login pages')}
                </label>
                <select
                  value={brandingSettings.login_logo_size || 'medium'}
                  onChange={(e) => handleBrandingChange('login_logo_size', e.target.value as 'small' | 'medium' | 'large' | 'xlarge')}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500"
                >
                  <option value="small">{t('branding.loginLogo.sizeSmall', 'Small')}</option>
                  <option value="medium">{t('branding.loginLogo.sizeMedium', 'Medium (default)')}</option>
                  <option value="large">{t('branding.loginLogo.sizeLarge', 'Large')}</option>
                  <option value="xlarge">{t('branding.loginLogo.sizeXLarge', 'Extra large')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* White Label Settings */}
          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
            <h3 className="text-md font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('branding.whiteLabel', 'White Label')}</h3>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={brandingSettings.hide_powered_by === true}
                onChange={(e) => handleBrandingChange('hide_powered_by', e.target.checked)}
                className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {t('branding.hidePoweredBy', 'Hide "Powered by PicPeak" branding')}
                </span>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  {t('branding.hidePoweredByHelp', 'Remove the PicPeak attribution from gallery footers for a fully white-labeled experience')}
                </p>
              </div>
            </label>
          </div>

          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={brandingSettings.watermark_enabled}
                onChange={(e) => handleBrandingChange('watermark_enabled', e.target.checked)}
                className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              />
              <div>
                <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t('branding.enableWatermarks')}</span>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">{t('branding.watermarkHelp')}</p>
              </div>
            </label>
          </div>

          {/* Watermark Settings */}
          {brandingSettings.watermark_enabled && (
            <div className="mt-6 space-y-6 border-t border-neutral-200 dark:border-neutral-700 pt-6">
              <h3 className="text-md font-semibold text-neutral-900 dark:text-neutral-100">{t('branding.watermarkSettings')}</h3>

              {/* Watermark Logo Upload */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.watermarkLogo')}
                </label>
                <div className="space-y-2">
                  {brandingSettings.watermark_logo_url && (
                    <div className="flex items-center gap-2">
                      <img 
                        src={brandingSettings.watermark_logo_url.startsWith('http') ? brandingSettings.watermark_logo_url : buildResourceUrl(brandingSettings.watermark_logo_url)} 
                        alt="Current watermark" 
                        className="h-16 w-auto object-contain bg-neutral-100 dark:bg-neutral-700 p-2 rounded"
                      />
                      <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('branding.currentWatermark')}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleBrandingChange('watermark_logo_url', '')}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  )}
                  <div>
                    <input
                      type="file"
                      accept="image/png"
                      onChange={handleWatermarkLogoUpload}
                      className="hidden"
                      id="watermark-upload"
                    />
                    <label htmlFor="watermark-upload">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => document.getElementById('watermark-upload')?.click()}
                        leftIcon={<Upload className="w-4 h-4" />}
                      >
                        {t('branding.uploadWatermarkLogo')}
                      </Button>
                    </label>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{t('branding.watermarkHelp')}</p>
                  </div>
                </div>
              </div>

              {/* Position Selector */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.watermarkPosition')}
                </label>
                <div className="grid grid-cols-3 gap-2 max-w-xs">
                  {[
                    { value: 'top-left', label: t('branding.topLeft') },
                    { value: 'top-right', label: t('branding.topRight') },
                    { value: 'center', label: t('branding.center') },
                    { value: 'bottom-left', label: t('branding.bottomLeft') },
                    { value: 'bottom-right', label: t('branding.bottomRight') }
                  ].map((position) => (
                    <button
                      key={position.value}
                      type="button"
                      onClick={() => handleBrandingChange('watermark_position', position.value)}
                      className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                        brandingSettings.watermark_position === position.value
                          ? 'bg-accent-dark text-white border-accent-dark'
                          : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                      }`}
                    >
                      {position.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Opacity Slider */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.watermarkOpacity')}: {brandingSettings.watermark_opacity || 50}%
                </label>
                <input
                  type="range"
                  min="10"
                  max="100"
                  step="10"
                  value={brandingSettings.watermark_opacity || 50}
                  onChange={(e) => handleBrandingChange('watermark_opacity', parseInt(e.target.value))}
                  className="w-full slider"
                  style={{
                    WebkitAppearance: 'none',
                    appearance: 'none',
                    height: '8px',
                    background: '#d4d4d4',
                    borderRadius: '4px',
                    outline: 'none'
                  }}
                />
                <div className="flex justify-between text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  <span>10%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>

              {/* Size Slider */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.watermarkSize')}: {brandingSettings.watermark_size || 15}%
                </label>
                <input
                  type="range"
                  min="5"
                  max="30"
                  step="5"
                  value={brandingSettings.watermark_size || 15}
                  onChange={(e) => handleBrandingChange('watermark_size', parseInt(e.target.value))}
                  className="w-full slider"
                  style={{
                    WebkitAppearance: 'none',
                    appearance: 'none',
                    height: '8px',
                    background: '#d4d4d4',
                    borderRadius: '4px',
                    outline: 'none'
                  }}
                />
                <div className="flex justify-between text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  <span>5%</span>
                  <span>15%</span>
                  <span>30%</span>
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* Customer dashboard branding (#354). Sits between "Company
            Information" and "Gallery Theme" so it stays adjacent to the
            other brand-visibility controls. Self-hides when the
            customerPortal feature flag is off. */}
        <div className="mb-6">
          <CustomerDashboardBrandingSection />
        </div>

        {/* Theme Customization */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
            <Palette className="w-5 h-5" />
            {t('branding.galleryTheme')}
          </h2>
          <div className="mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isPreviewMode}
                onChange={(e) => setIsPreviewMode(e.target.checked)}
                className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
              />
              <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('branding.applyLivePreview')}</span>
            </label>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left side - Theme Customizer.
                The PDF typography card is injected via the
                customizer's `slotBeforeCustomCss` so it sits
                immediately after the web Typography & Style section
                and before the (often bulky) Custom CSS editor —
                keeps all typography choices visually grouped.
                Hidden when no PDF-producing feature is on; persisted
                via the top-level Save button (handleSave). */}
            <div>
              <ThemeCustomizerEnhanced
                value={currentTheme}
                onChange={handleThemeChange}
                presetName={currentThemeName}
                onPresetChange={handlePresetChange}
                showGalleryLayouts={true}
                hideActions={true}
                forceColorMode={brandingSettings.force_color_mode ?? null}
                onForceColorModeChange={handleForceColorModeChange}
                slotBeforeCustomCss={
                  (flags.quotes || flags.bills || flags.taxReport)
                    ? <PdfTypographyCard value={pdfFontFamily} onChange={setPdfFontFamily} />
                    : null
                }
              />
            </div>

            {/* Right side - Gallery Preview */}
            <div className="lg:sticky lg:top-4 lg:h-fit">
              <Card className="p-4">
                <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-3">
                  {t('branding.livePreview')}
                </h3>
                <GalleryPreview
                  theme={currentTheme}
                  branding={{ ...brandingSettings, logo_url_dark: logoDarkUrl }}
                  className="shadow-lg"
                />
              </Card>
            </div>
          </div>
        </div>

        {/* Event-Specific Themes Info */}
        <Card padding="md" className="bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800">
          <div className="flex items-start gap-3">
            <Palette className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-medium text-blue-900 dark:text-blue-200">{t('branding.eventSpecificThemes')}</h3>
              <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                {t('branding.eventThemesInfo')}
              </p>
            </div>
          </div>
        </Card>
      </div>
    </ErrorBoundary>
  );
};

/**
 * Customer-dashboard branding card. Pulled out so the BrandingPage
 * stays readable and the feature-flag gate is local — no conditional
 * hooks in the parent.
 */
const CustomerDashboardBrandingSection: React.FC = () => {
  const customerPortalEnabled = useFeatureEnabled('customerPortal');
  if (!customerPortalEnabled) return null;
  return <CustomerDashboardBrandingCard />;
};
