import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Clock, Download, LogOut, Facebook, Instagram, Twitter, Youtube, MessageCircle } from 'lucide-react';
import { parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { Button, MarkdownContent } from '../common';
import { DynamicFavicon } from '../common/DynamicFavicon';
import { useTheme } from '../../contexts/ThemeContext';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { buildResourceUrl } from '../../utils/url';
import { cmsService, type PublicCMSPage } from '../../services/cms.service';
import type { HeaderStyleType } from '../../types/theme.types';

interface GalleryLayoutProps {
  event: {
    event_name: string;
    event_type?: string;
    event_date?: string | null;
    expires_at?: string | null;
    // Per-event promotional override (#440). 'inherit' uses the global
    // branding_promo_markdown; 'custom' renders promo_markdown below;
    // 'off' hides the promo slot entirely for this event.
    promo_mode?: 'inherit' | 'custom' | 'off';
    promo_markdown?: string | null;
  };
  brandingSettings?: {
    company_name?: string;
    company_tagline?: string;
    support_email?: string;
    footer_text?: string;
    favicon_url?: string;
    logo_url?: string;
    logo_size?: 'small' | 'medium' | 'large' | 'xlarge' | 'custom';
    logo_max_height?: number;
    logo_position?: 'left' | 'center' | 'right';
    logo_display_header?: boolean;
    logo_display_hero?: boolean;
    logo_display_mode?: 'logo_only' | 'text_only' | 'logo_and_text';
    hide_powered_by?: boolean;
    // Footer overhaul (#441 + #440). Empty strings hide each socials icon.
    facebook_url?: string;
    instagram_url?: string;
    whatsapp_url?: string;
    twitter_url?: string;
    youtube_url?: string;
    promo_markdown?: string;
    promo_position?: 'above_footer' | 'below_footer';
    // Horizontal alignment for the promo content (#482). Defaults
    // to 'center' so the banner aligns with the footer.
    promo_alignment?: 'left' | 'center' | 'right';
  };
  showLogout?: boolean;
  onLogout?: () => void;
  showDownloadAll?: boolean;
  onDownloadAll?: () => void;
  isDownloading?: boolean;
  /**
   * "Download" CTA shown immediately to the left of the Logout button in the
   * standard / banner header. Same handler as Download All; the label and
   * placement are intentionally simpler — single primary action right before
   * Logout, the natural step at the end of a gallery visit (#386). Always
   * visible when allowed (independent of sidebar state) so guests aren't
   * forced to discover the download in the menu.
   */
  showHeaderDownload?: boolean;
  onHeaderDownload?: () => void;
  headerExtra?: React.ReactNode;
  menuButton?: React.ReactNode;
  headerStyle?: HeaderStyleType;
  children: React.ReactNode;
}

/**
 * Accent-coloured "Download" CTA shown immediately to the left of the
 * Logout button. Identical markup is rendered in three header variants
 * (standard/banner, minimal, hero) — extracted into a small component
 * here so changes (label, icon, contrast) only need to happen in one
 * place. Background reads `--color-accent`; text reads `--color-accent-fg`
 * which `ThemeContext.applyTheme` derives from the accent's luminance,
 * so a pale accent automatically gets dark text and a saturated accent
 * gets white. Falls back to white if the variable isn't set (legacy
 * deployments before the contrast helper landed).
 */
const HeaderDownloadButton: React.FC<{
  onClick: () => void;
  isDownloading?: boolean;
  label: string;
}> = ({ onClick, isDownloading = false, label }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={isDownloading}
    aria-label={label}
    className="gallery-btn gallery-btn-download inline-flex items-center gap-2 px-3 sm:px-4 h-9 rounded-lg text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
    style={{
      backgroundColor: 'var(--color-accent)',
      color: 'var(--color-accent-fg, #ffffff)',
    }}
  >
    <Download className="w-4 h-4" />
    <span className="hidden sm:inline">{label}</span>
  </button>
);

export const GalleryLayout: React.FC<GalleryLayoutProps> = ({
  event,
  brandingSettings,
  showLogout = false,
  onLogout,
  showDownloadAll = false,
  onDownloadAll,
  isDownloading = false,
  showHeaderDownload = false,
  onHeaderDownload,
  headerExtra,
  menuButton,
  headerStyle: headerStyleProp,
  children,
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { theme } = useTheme();
  const guestIdentity = useGuestIdentityOptional();

  // Footer legal-link config. Cached aggressively because the toggle state
  // changes rarely and the gallery footer renders on every page view.
  // Failures fall back to the internal /impressum and /datenschutz routes.
  const { data: impressumPage } = useQuery<PublicCMSPage>({
    queryKey: ['public-cms', 'impressum'],
    queryFn: () => cmsService.getPublicPage('impressum'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const { data: datenschutzPage } = useQuery<PublicCMSPage>({
    queryKey: ['public-cms', 'datenschutz'],
    queryFn: () => cmsService.getPublicPage('datenschutz'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Determine header style - use prop first (from event data), then theme, then fall back to 'standard'
  const headerStyle: HeaderStyleType = headerStyleProp || theme.headerStyle || 'standard';
  const isHeroHeader = headerStyle === 'hero';
  const isBannerHeader = headerStyle === 'banner';
  const isMinimalHeader = headerStyle === 'minimal';
  const isNoHeader = headerStyle === 'none';
  const fontFamily = theme.fontFamily || 'Inter, sans-serif';
  const headingFontFamily = theme.headingFontFamily || fontFamily;
  
  // Calculate logo size classes based on settings
  const getLogoDimensions = (context: 'header' | 'hero'): { className: string; style?: React.CSSProperties } => {
    const size = brandingSettings?.logo_size || 'medium';
    const maxHeight = brandingSettings?.logo_max_height || 48;

    if (size === 'custom') {
      return {
        className: '',
        style: { maxHeight: `${maxHeight}px`, height: 'auto' }
      };
    }

    const sizeMap: Record<'small' | 'medium' | 'large' | 'xlarge', string> = {
      small: context === 'header' ? 'h-6 sm:h-8' : 'h-12 sm:h-14 lg:h-16',
      medium: context === 'header' ? 'h-8 sm:h-10 lg:h-12' : 'h-16 sm:h-20 lg:h-24',
      large: context === 'header' ? 'h-10 sm:h-12 lg:h-16' : 'h-20 sm:h-24 lg:h-32',
      xlarge: context === 'header' ? 'h-12 sm:h-16 lg:h-20' : 'h-24 sm:h-32 lg:h-40'
    };

    return {
      className: sizeMap[size as keyof typeof sizeMap] || sizeMap.medium,
      style: undefined
    };
  };
  
  // Determine logo position classes
  const getLogoPositionClass = () => {
    const position = brandingSettings?.logo_position || 'left';
    return {
      left: 'justify-start',
      center: 'justify-center',
      right: 'justify-end'
    }[position];
  };
  
  // Check if logo should be displayed
  const shouldShowLogo = (context: 'header' | 'hero') => {
    const displayMode = brandingSettings?.logo_display_mode || 'logo_and_text';
    if (displayMode === 'text_only') return false;
    
    if (context === 'header') {
      return brandingSettings?.logo_display_header !== false;
    } else {
      return brandingSettings?.logo_display_hero !== false;
    }
  };
  
  // Check if company name should be displayed
  const shouldShowCompanyName = () => {
    const displayMode = brandingSettings?.logo_display_mode || 'logo_and_text';
    return displayMode !== 'logo_only';
  };

  const headerLogoSize = getLogoDimensions('header');
  const heroLogoSize = getLogoDimensions('hero');

  // Footer overhaul (#441 + #440). All five socials are independent;
  // empty string = hide just that icon. Per-event promo override:
  //   - off: never render the promo slot for this event
  //   - custom: render event.promo_markdown (falls back to global if blank)
  //   - inherit (default): render branding_promo_markdown
  const socialLinks: Array<{ key: string; href: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
    { key: 'facebook', href: brandingSettings?.facebook_url || '', label: 'Facebook', Icon: Facebook },
    { key: 'instagram', href: brandingSettings?.instagram_url || '', label: 'Instagram', Icon: Instagram },
    { key: 'whatsapp', href: brandingSettings?.whatsapp_url || '', label: 'WhatsApp', Icon: MessageCircle },
    { key: 'twitter', href: brandingSettings?.twitter_url || '', label: 'X / Twitter', Icon: Twitter },
    { key: 'youtube', href: brandingSettings?.youtube_url || '', label: 'YouTube', Icon: Youtube },
  ].filter(link => link.href.trim().length > 0);

  const promoMode = event.promo_mode || 'inherit';
  const promoMarkdown = (() => {
    if (promoMode === 'off') return '';
    if (promoMode === 'custom') {
      const eventMd = (event.promo_markdown || '').trim();
      return eventMd || (brandingSettings?.promo_markdown || '');
    }
    return brandingSettings?.promo_markdown || '';
  })().trim();
  const promoPosition: 'above_footer' | 'below_footer' = brandingSettings?.promo_position === 'below_footer' ? 'below_footer' : 'above_footer';

  // Promo alignment (#482). Defaults to 'center' to match the gallery
  // footer's `text-center px-4` so the banner reads as part of the
  // same composition as the footer beneath it. Admin can flip to
  // 'left' or 'right' from Settings → Branding.
  const promoAlignment: 'left' | 'center' | 'right' =
    brandingSettings?.promo_alignment === 'left' ? 'left'
      : brandingSettings?.promo_alignment === 'right' ? 'right'
      : 'center';
  const promoTextAlignClass =
    promoAlignment === 'left' ? 'text-left'
      : promoAlignment === 'right' ? 'text-right'
      : 'text-center';

  const promoSlot = promoMarkdown ? (
    <div className="gallery-promo border-t border-surface bg-surface/50">
      {/*
       * Inner block uses .container (matches the footer's container
       * width) + the alignment class. We deliberately drop the
       * previous max-w-3xl wrapper — it created a narrower column
       * that read as visually offset from the full-width footer
       * (#482, reported by Rekoo-PS). The `prose` class is needed
       * for the prose-a:text-accent modifier to actually take effect
       * (modifiers without an outer .prose are no-ops in Tailwind
       * Typography).
       */}
      <div className={`container py-4 sm:py-6 px-4 ${promoTextAlignClass}`}>
        <MarkdownContent
          source={promoMarkdown}
          className={`prose prose-sm max-w-none mx-auto text-sm text-theme prose-a:text-accent ${promoTextAlignClass}`}
        />
      </div>
    </div>
  ) : null;

  // Legal links per #441: each CMS page has show_in_footer (default true).
  // When BOTH are hidden we still render the surrounding row only if
  // there's a guest "Forget me" button or socials to show.
  const showImpressum = impressumPage?.show_in_footer !== false;
  const showDatenschutz = datenschutzPage?.show_in_footer !== false;
  const hasLegalLinks = showImpressum || showDatenschutz;
  const hasFooterRow = hasLegalLinks || socialLinks.length > 0 || !!guestIdentity?.identity;

  return (
    <div className="gallery-page min-h-screen" style={{ backgroundColor: 'var(--color-background)' }}>
      {/* Dynamic Favicon */}
      <DynamicFavicon />

      {/* Header structure */}
      <header className={`gallery-header bg-surface border-b border-surface sticky top-0 z-40 ${isHeroHeader || isBannerHeader ? 'shadow-sm' : ''}`}>
        {/* Standard / Banner header - full bar with logo, event info, and actions (all layouts) */}
        {!isHeroHeader && !isMinimalHeader && !isNoHeader && (
          <div className="container py-3 relative">
            {/*
             * Menu icon is absolute-positioned at the very left of the header
             * row instead of sitting inside the flex flow, so the logo's left
             * edge can align with the leftmost gallery image (both anchored at
             * `.container` left padding) — see #386. The icon stays vertically
             * centred via top-1/2 + -translate-y-1/2.
             */}
            {menuButton && (
              <div className="absolute left-3 sm:left-6 lg:left-8 top-1/2 -translate-y-1/2 z-10">
                {menuButton}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 sm:gap-4">
              {/* Left side - Logo (menu lives in the absolute wrapper above) */}
              <div className={`flex items-center gap-2 sm:gap-4 flex-shrink-0 ${menuButton ? 'pl-12 sm:pl-14' : ''}`}>
                {/* Logo - Show custom logo or fallback to PicPeak logo */}
                {shouldShowLogo('header') && (
                  <div className={`gallery-logo-wrapper flex-shrink-0 flex items-center gap-2 ${brandingSettings?.logo_position === 'center' ? 'flex-1' : ''} ${getLogoPositionClass()}`}>
                    <img
                      src={brandingSettings?.logo_url ?
                        buildResourceUrl(brandingSettings.logo_url) :
                        '/picpeak-logo-transparent.png'
                      }
                      alt={brandingSettings?.company_name || 'PicPeak'}
                      className={`gallery-logo ${headerLogoSize.className} w-auto object-contain`}
                      style={headerLogoSize.style}
                    />
                    {shouldShowCompanyName() && brandingSettings?.company_name && (
                      <span className="hidden sm:inline text-lg font-semibold text-theme">
                        {brandingSettings.company_name}
                      </span>
                    )}
                  </div>
                )}
                {!shouldShowLogo('header') && shouldShowCompanyName() && brandingSettings?.company_name && (
                  <div className={`flex-shrink-0 ${brandingSettings?.logo_position === 'center' ? 'flex-1' : ''} ${getLogoPositionClass()}`}>
                    <span className="text-lg font-semibold text-theme">
                      {brandingSettings.company_name || 'PicPeak'}
                    </span>
                  </div>
                )}
              </div>
              
              {/* Center - Event info */}
              <div className="flex-1 min-w-0 text-center sm:text-left">
                <h1 
                  className="text-base sm:text-lg lg:text-xl font-bold text-theme leading-tight truncate"
                  style={{ fontFamily: headingFontFamily }}
                >
                  {event.event_name}
                </h1>
                {(event.event_date || event.expires_at) && (
                  <div className="hidden sm:flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs sm:text-sm text-muted-theme">
                    {event.event_date && (
                      <span className="flex items-center">
                        <Calendar className="w-3 h-3 sm:w-4 sm:h-4 mr-1 flex-shrink-0" />
                        <span>{format(parseISO(event.event_date), 'PP')}</span>
                      </span>
                    )}
                    {event.expires_at && (
                      <span className="flex items-center">
                        <Clock className="w-3 h-3 sm:w-4 sm:h-4 mr-1 flex-shrink-0" />
                        <span>{t('gallery.expires')} {format(parseISO(event.expires_at), 'PP')}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
              
              {/* Right side - Action buttons */}
              <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
                {/* Extra header items (upload button, etc.) */}
                {headerExtra}
                
                {/* Download all button - hidden on mobile when sidebar is shown */}
                {showDownloadAll && onDownloadAll && (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Download className="w-4 h-4" />}
                    onClick={onDownloadAll}
                    isLoading={isDownloading}
                    className="gallery-btn gallery-btn-download hidden sm:flex"
                  >
                    <span className="hidden sm:inline">{t('gallery.downloadAll')}</span>
                    <span className="sm:hidden">{t('common.download')}</span>
                  </Button>
                )}

                {/*
                 * "Download" CTA — accent-coloured button immediately left of
                 * Logout, always visible when the gallery allows downloads.
                 * Markup lives in HeaderDownloadButton above; reused in the
                 * minimal and hero headers below.
                 */}
                {showHeaderDownload && onHeaderDownload && (
                  <HeaderDownloadButton
                    onClick={onHeaderDownload}
                    isDownloading={isDownloading}
                    label={t('gallery.download', 'Download')}
                  />
                )}

                {/* Logout button */}
                {showLogout && onLogout && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<LogOut className="w-4 h-4" />}
                    onClick={onLogout}
                    className="gallery-btn gallery-btn-logout sm:min-w-0"
                  >
                    <span className="hidden sm:inline">{t('common.logout')}</span>
                  </Button>
                )}
              </div>
            </div>
            
            {/* Mobile dates row */}
            {(event.event_date || event.expires_at) && (
              <div className="flex sm:hidden justify-center gap-x-3 mt-2 text-xs text-muted-theme">
                {event.event_date && (
                  <span className="flex items-center">
                    <Calendar className="w-3 h-3 mr-1 flex-shrink-0" />
                    <span>{format(parseISO(event.event_date), 'PP')}</span>
                  </span>
                )}
                {event.expires_at && (
                  <span className="flex items-center">
                    <Clock className="w-3 h-3 mr-1 flex-shrink-0" />
                    <span>{t('gallery.expires')} {format(parseISO(event.expires_at), 'PP')}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Minimal header - compact bar with event name (all layouts) */}
        {isMinimalHeader && (
          <div className="container py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {menuButton}
                <h1
                  className="text-sm font-semibold text-theme truncate"
                  style={{ fontFamily: headingFontFamily }}
                >
                  {event.event_name}
                </h1>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {headerExtra}
                {showDownloadAll && onDownloadAll && (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Download className="w-4 h-4" />}
                    onClick={onDownloadAll}
                    isLoading={isDownloading}
                    className="gallery-btn gallery-btn-download hidden sm:flex"
                  >
                    <span className="hidden sm:inline">{t('gallery.downloadAll')}</span>
                  </Button>
                )}
                {/* Accent Download CTA — also rendered in the minimal header
                    so the action stays one click away regardless of header
                    style. Intentionally NOT shown in the no-header variant
                    where the gallery is fully chromeless by design. */}
                {showHeaderDownload && onHeaderDownload && (
                  <HeaderDownloadButton
                    onClick={onHeaderDownload}
                    isDownloading={isDownloading}
                    label={t('gallery.download', 'Download')}
                  />
                )}
                {showLogout && onLogout && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<LogOut className="w-4 h-4" />}
                    onClick={onLogout}
                    className="gallery-btn gallery-btn-logout sm:min-w-0"
                  >
                    <span className="hidden sm:inline">{t('common.logout')}</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* No-header style - just functional buttons, no event info (all layouts) */}
        {isNoHeader && (
          <div className="container py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {menuButton}
                {headerExtra}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {showDownloadAll && onDownloadAll && (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Download className="w-4 h-4" />}
                    onClick={onDownloadAll}
                    isLoading={isDownloading}
                    className="gallery-btn gallery-btn-download hidden sm:flex"
                  >
                    <span className="hidden sm:inline">{t('gallery.downloadAll')}</span>
                  </Button>
                )}
                {showLogout && onLogout && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<LogOut className="w-4 h-4" />}
                    onClick={onLogout}
                    className="gallery-btn gallery-btn-logout sm:min-w-0"
                  >
                    <span className="hidden sm:inline">{t('common.logout')}</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* For hero header style - minimal header with just menu and logout */}
        {isHeroHeader && (
          <div className="container py-3">
            <div className="flex items-center justify-between">
              {/* Left side - Menu button */}
              <div className="flex items-center gap-3">
                {menuButton}
                {headerExtra}
              </div>

              {/* Right side - Action buttons */}
              <div className="flex items-center gap-3 flex-shrink-0">
                {/* Download all button */}
                {showDownloadAll && onDownloadAll && (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Download className="w-4 h-4" />}
                    onClick={onDownloadAll}
                    isLoading={isDownloading}
                    className="gallery-btn gallery-btn-download"
                  >
                    <span className="hidden sm:inline">{t('gallery.downloadAll')}</span>
                    <span className="sm:hidden">{t('common.download')}</span>
                  </Button>
                )}

                {/* Accent Download CTA — also rendered above the hero so the
                    primary download action is reachable without scrolling.
                    Intentionally NOT shown in the no-header variant where
                    the gallery is fully chromeless by design. */}
                {showHeaderDownload && onHeaderDownload && (
                  <HeaderDownloadButton
                    onClick={onHeaderDownload}
                    isDownloading={isDownloading}
                    label={t('gallery.download', 'Download')}
                  />
                )}

                {/* Logout button */}
                {showLogout && onLogout && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<LogOut className="w-4 h-4" />}
                    onClick={onLogout}
                    className="gallery-btn gallery-btn-logout sm:min-w-0"
                  >
                    <span className="hidden sm:inline">{t('common.logout')}</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Colored banner — only when headerStyle === 'banner', regardless of layout */}
      {isBannerHeader && (
        <div
          className="gallery-hero relative text-white overflow-hidden"
          style={{
            backgroundColor: theme.accentColor || '#22c55e',
            backgroundImage: theme.backgroundPattern !== 'none' 
              ? `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M0 40L40 0H20L0 20M40 40V20L20 40'/%3E%3C/g%3E%3C/svg%3E")`
              : undefined
          }}
        >
          <div className="container py-12 sm:py-16 lg:py-20 relative z-10">
            <div className="text-center max-w-4xl mx-auto">
              {/* Logo - Show custom logo or fallback to PicPeak logo */}
              {shouldShowLogo('hero') && (
                <div className="mb-6">
                  <img 
                    src={brandingSettings?.logo_url ? 
                      buildResourceUrl(brandingSettings.logo_url) : 
                      '/picpeak-logo-transparent.png'
                    } 
                    alt={brandingSettings?.company_name || 'PicPeak'}
                    className={`${heroLogoSize.className} w-auto object-contain mx-auto`}
                    style={{
                      ...(heroLogoSize.style || {}),
                      // Only apply brightness/invert filter to default logo; custom logos display as-is
                      filter: brandingSettings?.logo_url
                        ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))'
                        : 'brightness(0) invert(1) drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))'
                    }}
                  />
                  {shouldShowCompanyName() && brandingSettings?.company_name && (
                    <div className="mt-3 text-xl sm:text-2xl font-semibold text-white/90" style={{ textShadow: '0 2px 4px rgba(0, 0, 0, 0.3)' }}>
                      {brandingSettings.company_name}
                    </div>
                  )}
                </div>
              )}
              {!shouldShowLogo('hero') && shouldShowCompanyName() && brandingSettings?.company_name && (
                <div className="mb-6 text-2xl sm:text-3xl font-bold text-white" style={{ textShadow: '0 2px 4px rgba(0, 0, 0, 0.3)' }}>
                  {brandingSettings.company_name || 'PicPeak'}
                </div>
              )}
              
              {/* Event Name */}
              <h1 
                className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4"
                style={{ 
                  fontFamily: headingFontFamily,
                  textShadow: '0 2px 4px rgba(0, 0, 0, 0.3)'
                }}
              >
                {event.event_name}
              </h1>
              
              {/* Event Details */}
              {(event.event_date || event.expires_at) && (
                <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 text-white/80" style={{ textShadow: '0 1px 3px rgba(0, 0, 0, 0.3)' }}>
                  {event.event_date && (
                    <span className="flex items-center text-lg">
                      <Calendar className="w-5 h-5 mr-2" />
                      {format(parseISO(event.event_date), 'PP')}
                    </span>
                  )}
                  {event.expires_at && (
                    <span className="flex items-center text-lg">
                      <Clock className="w-5 h-5 mr-2" />
                      {t('gallery.expires')} {format(parseISO(event.expires_at), 'PP')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          
          {/* Decorative bottom wave */}
          <div className="absolute bottom-0 left-0 right-0">
            <svg className="w-full h-12 sm:h-16" viewBox="0 0 1200 120" preserveAspectRatio="none">
              <path d="M0,60 C150,90 350,30 600,60 C850,90 1050,30 1200,60 L1200,120 L0,120 Z" 
                fill="var(--color-background, #fafafa)" />
            </svg>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="container">{children}</main>

      {/* Promotional banner (#440) — rendered above the footer when
          branding_promo_position = 'above_footer' (the default). */}
      {promoPosition === 'above_footer' && promoSlot}

      {/* Footer */}
      <footer className="gallery-footer mt-8 sm:mt-12 py-6 sm:py-8 border-t border-surface">
        <div className="container text-center px-4">
          {brandingSettings?.support_email && (
            <p className="text-xs sm:text-sm text-muted-theme mb-2">
              {t('gallery.needHelp')}{' '}
              <a
                href={`mailto:${brandingSettings.support_email}`}
                className="text-accent hover:opacity-80 break-all"
              >
                {brandingSettings.support_email}
              </a>
            </p>
          )}
          <p className="text-xs sm:text-sm text-muted-theme">
            {brandingSettings?.footer_text || `© ${new Date().getFullYear()}${brandingSettings?.company_name ? ` ${brandingSettings.company_name}` : ''}. All rights reserved.`}
            {!brandingSettings?.hide_powered_by && (
              <> | Powered by <span className="font-semibold">PicPeak</span></>
            )}
          </p>
          {brandingSettings?.company_name && brandingSettings?.company_tagline && (
            <p className="text-xs text-muted-theme mt-2">
              {brandingSettings.company_name} - {brandingSettings.company_tagline}
            </p>
          )}

          {/* Socials row (#441) — only rendered when at least one URL is set. */}
          {socialLinks.length > 0 && (
            <div className="mt-4 flex items-center justify-center gap-3 flex-wrap" aria-label={t('gallery.footer.socials', 'Social media')}>
              {socialLinks.map(({ key, href, label, Icon }) => (
                <a
                  key={key}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="text-muted-theme hover:text-accent transition-colors"
                >
                  <Icon className="w-5 h-5" />
                </a>
              ))}
            </div>
          )}

          {/* Legal Links (#441) — each CMS page has show_in_footer.
              Only renders the row if there's something to put in it. */}
          {hasFooterRow && (
            <div className="mt-4 flex items-center justify-center gap-4 flex-wrap">
              {showImpressum && (
                impressumPage?.use_external_url && impressumPage.external_url ? (
                  <a
                    href={impressumPage.external_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-theme hover:text-theme transition-colors"
                  >
                    {t('legal.impressum')}
                  </a>
                ) : (
                  <Link
                    to="/impressum"
                    className="text-xs text-muted-theme hover:text-theme transition-colors"
                  >
                    {t('legal.impressum')}
                  </Link>
                )
              )}
              {showImpressum && showDatenschutz && (
                <span className="text-xs text-muted-theme">|</span>
              )}
              {showDatenschutz && (
                datenschutzPage?.use_external_url && datenschutzPage.external_url ? (
                  <a
                    href={datenschutzPage.external_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-theme hover:text-theme transition-colors"
                  >
                    {t('legal.datenschutz')}
                  </a>
                ) : (
                  <Link
                    to="/datenschutz"
                    className="text-xs text-muted-theme hover:text-theme transition-colors"
                  >
                    {t('legal.datenschutz')}
                  </Link>
                )
              )}
              {guestIdentity?.identity && (
                <>
                  {hasLegalLinks && <span className="text-xs text-muted-theme">|</span>}
                  <button
                    type="button"
                    className="text-xs text-muted-theme hover:text-theme transition-colors"
                    onClick={async () => {
                      if (window.confirm(t('gallery.footer.forgetMeConfirm', 'Your name and selections will be removed from this gallery.'))) {
                        await guestIdentity.forget();
                      }
                    }}
                  >
                    {t('gallery.footer.forgetMe', 'Forget me ({{name}})', { name: guestIdentity.identity.name })}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </footer>

      {/* Promotional banner (#440) — rendered below the footer when
          branding_promo_position = 'below_footer'. */}
      {promoPosition === 'below_footer' && promoSlot}
    </div>
  );
};

GalleryLayout.displayName = 'GalleryLayout';
