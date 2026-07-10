import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, User, LogOut, Settings, Bell, Lock, CheckCircle, Trash2, Sun, Moon, Globe, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { useAdminAuth } from '../../contexts';
import { useAdminDarkMode } from '../../contexts/AdminDarkModeContext';
import { useOnClickOutside } from '../../hooks/useOnClickOutside';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { useModal } from '../../hooks';
import { PasswordChangeModal } from './PasswordChangeModal';
import { LanguageSelector, SUPPORTED_LANGUAGES } from '../common';
import { notificationsService } from '../../services/notifications.service';
import { toast } from 'react-toastify';
import { buildResourceUrl } from '../../utils/url';

interface AdminHeaderProps {
  onMenuClick: () => void;
}

export const AdminHeader: React.FC<AdminHeaderProps> = ({ onMenuClick }) => {
  const navigate = useNavigate();
  const { user, logout } = useAdminAuth();
  const { isDark, toggle: toggleDarkMode, forcedMode } = useAdminDarkMode();
  const { t, i18n } = useTranslation();
  const { format, formatDistanceToNow } = useLocalizedDate();
  const userMenuModal = useModal();
  const userMenuLangSectionModal = useModal();
  const notificationsModal = useModal();
  const passwordModal = useModal();
  const queryClient = useQueryClient();

  const { data: brandingSettings, isLoading: brandingLoading } = usePublicSettings();
  const currentLanguage = SUPPORTED_LANGUAGES.find(lang => lang.code === i18n.language) || SUPPORTED_LANGUAGES[0];

  const companyName = brandingSettings?.branding_company_name?.trim() || 'PicPeak';
  // Dark-mode logo variant. Symmetric fallback: if only one logo is set,
  // use it for both modes (dark → dark||light, light → light||dark).
  const lightLogo = brandingSettings?.branding_logo_url?.trim();
  const darkLogo = brandingSettings?.branding_logo_url_dark?.trim();
  const logoUrl = isDark ? (darkLogo || lightLogo) : (lightLogo || darkLogo);
  const logoDisplayMode = brandingSettings?.branding_logo_display_mode || 'logo_and_text';
  // Logo placement honours the same Branding > Logo Position setting
  // the gallery does. 'sidepanel' moves the logo into the AdminSidebar
  // brand row — suppress it here so it doesn't double up. left /
  // center / right reposition the logo block within this header bar.
  const logoPosition = brandingSettings?.branding_logo_position || 'left';
  const logoInSidebar = logoPosition === 'sidepanel';
  const resolvedLogoUrl = logoUrl
    ? (logoUrl.startsWith('http') ? logoUrl : buildResourceUrl(logoUrl))
    : '/picpeak-kamera-transparent.png';

  // #523 follow-up 2: graceful fallback when the configured logo URL
  // 404s or stalls. Without an error handler, the <img> failure draws
  // the browser's default broken-image-icon + alt text rendering — see
  // Rekoo-PS's 3.60.3-beta.0 screenshot where "Arkan Studio" appeared
  // as the alt text of a broken icon, not the real wordmark span. The
  // chain:
  //   1. configured URL fails → try the bundled picpeak fallback
  //   2. bundled fallback fails → hide the image entirely, let the
  //      wordmark carry the brand
  // Reset on URL change so a dark-mode toggle (which can flip lightLogo
  // ↔ darkLogo) retries the new URL instead of being permanently sad.
  const [logoLoadError, setLogoLoadError] = useState(false);
  const [fallbackLoadError, setFallbackLoadError] = useState(false);
  useEffect(() => {
    setLogoLoadError(false);
    setFallbackLoadError(false);
  }, [resolvedLogoUrl]);
  const logoImgSrc = logoLoadError ? '/picpeak-kamera-transparent.png' : resolvedLogoUrl;

  // Renders the logo + wordmark block per the current logo_display_mode.
  // Re-used in left / center / right slots below so all three positions
  // produce visually identical brand chrome.
  const showLogo = !logoInSidebar && (logoDisplayMode === 'logo_only' || logoDisplayMode === 'logo_and_text');
  const showText = logoDisplayMode === 'text_only' || logoDisplayMode === 'logo_and_text';
  const logoEffectivelyVisible = showLogo && !fallbackLoadError;
  // On <sm the wordmark hides when the logo carries the brand identity
  // (logo_and_text). Same pattern LanguageSelector uses for its language
  // name (#527). Without this, even with truncate, a phone-width admin
  // shows things like "Ar..." after the logo image — readable but ugly,
  // and on accounts whose company name lets the text reach the right
  // cluster it overlaps the LanguageSelector button (#523 follow-up,
  // Rekoo-PS's "Arkan Studio" screenshot in v3.59.0-beta.0). text_only
  // mode keeps the wordmark on every width — nothing else would render.
  //
  // #523 follow-up 2: when both the configured URL AND the bundled
  // fallback have failed (fallbackLoadError → logoEffectivelyVisible
  // false), unhide the wordmark on <sm too — otherwise the phone header
  // shows nothing at all for the brand block.
  const wordmarkVisibilityClass = logoEffectivelyVisible ? 'hidden sm:inline' : 'inline';
  const renderBrandBlock = () => {
    // Skeleton placeholder while `usePublicSettings()` is in flight (#523
    // follow-up — Rekoo-PS's "logo took some time to load" screenshot in
    // 3.60.1-beta.0). The previous code used the static fallback image
    // /picpeak-kamera-transparent.png as the during-loading state, and
    // because the wordmark is `hidden sm:inline` whenever a logo is
    // *intended* to be shown, a phone-width admin saw an empty header
    // for the ~hundreds-of-ms window before the real branding payload
    // arrived. The skeleton block holds the same h-8 (so no layout
    // shift when the real content lands) and is wider on sm+ to hint
    // at the wordmark slot.
    if (brandingLoading) {
      return (
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-8 w-8 sm:w-32 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" />
        </div>
      );
    }
    // min-w-0 + truncate on the name span so long company names shrink
    // within the left cluster instead of pushing into the right-side
    // action buttons on narrow mobile widths (#523 regression).
    return (
      <div className="flex items-center gap-2 min-w-0">
        {logoEffectivelyVisible && (
          <img
            src={logoImgSrc}
            alt={companyName}
            className="h-8 w-auto object-contain flex-shrink-0"
            onError={() => {
              // First failure: configured URL → try the bundled fallback.
              // Second failure: bundled fallback → hide entirely, let
              // the wordmark carry the brand (#523 follow-up 2).
              if (!logoLoadError) setLogoLoadError(true);
              else setFallbackLoadError(true);
            }}
          />
        )}
        {showText && (
          <span className={`${wordmarkVisibilityClass} text-xl sm:text-2xl truncate`} style={{ fontFamily: 'Poppins, sans-serif', fontWeight: 600, color: '#145346' }}>{companyName}</span>
        )}
      </div>
    );
  };

  // #523 follow-up: closes the user-menu lang sub-section whenever the
  // outer dropdown closes, so re-opening it doesn't surprise the user
  // with the language list already expanded from the previous session.
  const closeUserMenu = () => {
    userMenuModal.close();
    userMenuLangSectionModal.close();
  };
  const handleUserMenuLangSelect = (languageCode: string) => {
    i18n.changeLanguage(languageCode);
    closeUserMenu();
  };

  const userMenuRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);

  useOnClickOutside(userMenuRef, closeUserMenu);
  useOnClickOutside(notificationRef, notificationsModal.close);

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  // Fetch notifications
  const { data: notificationsData } = useQuery({
    queryKey: ['notifications', notificationsModal.isOpen],
    queryFn: () => notificationsService.getNotifications(notificationsModal.isOpen, 20),
    refetchInterval: 60000, // Refetch every minute
  });

  // Mark all as read mutation
  const markAllAsReadMutation = useMutation({
    mutationFn: notificationsService.markAllAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success(t('admin.notificationToasts.markedAllRead'));
    },
  });

  // Clear notifications mutation
  const clearAllMutation = useMutation({
    mutationFn: notificationsService.clearAllNotifications,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success(t('admin.notificationToasts.clearedAll', { count: data.deletedCount }));
    },
  });

  const notifications = notificationsData?.notifications || [];
  const unreadCount = notificationsData?.unreadCount || 0;

  return (
    // border-b is on the OUTER <header> so it spans the full header
    // width — putting it on the inner row instead left a 32px gap on
    // the left (the px-4/sm:px-6/lg:px-8 padding) before the divider
    // started, visible as a missing segment between the sidebar's
    // brand-row bottom border and the header's bottom border.
    //
    // The outer header is explicitly h-16 with the default border-box,
    // so the 1px border is painted INSIDE the 64px height (y=63..64)
    // — same model as the sidebar's brand row (also h-16 border-b
    // border-box). Both bottom borders meet at the exact same
    // y-coordinate.
    <header className="sticky top-0 z-30 bg-white dark:bg-neutral-900 h-16 border-b border-neutral-200 dark:border-neutral-700">
      <div className="px-4 sm:px-6 lg:px-8 h-full">
        <div className="relative flex items-center justify-between h-full gap-3">
          {/* Left side - Menu button, optional left-positioned logo, Date.
              Logo block appears here when logo_position = 'left' (the
              default). For 'center' it's absolutely positioned across
              the whole header; for 'right' it sits in the right-side
              cluster just before the action widgets. */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onMenuClick}
              className="lg:hidden text-neutral-500 hover:text-neutral-700"
            >
              <Menu className="w-6 h-6" />
            </button>

            {!logoInSidebar && logoPosition === 'left' && renderBrandBlock()}
            {/* Narrow-viewport fallback for center / right positions.
                On screens where the centered (lg+) or right-anchored
                (md+) brand block is hidden, render it on the left so
                the admin chrome doesn't go logo-less on phones. */}
            {!logoInSidebar && logoPosition === 'center' && (
              <div className="flex lg:hidden">{renderBrandBlock()}</div>
            )}
            {!logoInSidebar && logoPosition === 'right' && (
              <div className="flex md:hidden">{renderBrandBlock()}</div>
            )}

            {/* Date display - hidden on smaller screens.
                The vertical divider + left padding only render when
                the logo sits on the left of the date (logo_position
                = 'left'). For 'center' / 'right' / 'sidepanel' the
                left cluster has only the mobile menu (which is
                hidden on xl+), so a divider would be floating on
                its own with nothing to separate. */}
            {/* Explicit `flex items-center` (not just block) + the
                self-stretch on the border-l variant so the divider
                covers the full header row, AND the text baseline sits
                exactly on the same y-axis as the brand-block / sidebar
                logo to its left. The previous `hidden xl:block` left
                the <p> inheriting its block-level vertical position,
                which read as slightly off-centre next to the larger
                logo image. */}
            <div className={`hidden xl:flex items-center self-stretch ml-1 ${
              logoPosition === 'left' && !logoInSidebar
                ? 'pl-3 border-l border-neutral-200 dark:border-neutral-700'
                : ''
            }`}>
              <p className="text-base leading-none text-neutral-700 dark:text-neutral-300 m-0">
                {format(new Date(), 'PPPP')}
              </p>
            </div>
          </div>

          {/* Centered logo. Absolutely positioned so the existing
              left/right clusters keep their natural sizing; hidden on
              sub-lg widths to avoid colliding with the right-side
              action cluster on narrow screens. pointer-events-none on
              the wrapper passes hover/click through (the logo itself
              has no interactive children today). */}
          {!logoInSidebar && logoPosition === 'center' && (
            <div className="hidden lg:flex absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
              {renderBrandBlock()}
            </div>
          )}

          {/* Right side actions (preceded by the brand block when
              logo_position = 'right'). The right-anchored logo sits
              before the language / dark-mode / notifications / user
              cluster so the widgets stay where admins expect them. */}
          <div className="flex items-center gap-3">
            {!logoInSidebar && logoPosition === 'right' && (
              <div className="hidden md:flex mr-1 pr-2 border-r border-neutral-200 dark:border-neutral-700">
                {renderBrandBlock()}
              </div>
            )}
            {/* Language Selector — hidden on <sm where it's surfaced
                via the user dropdown instead (#523 follow-up: phone
                view header was too crowded with 4 widgets; language
                is a set-once preference so it doesn't deserve permanent
                header real estate on mobile per Rekoo-PS's feedback). */}
            <div className="hidden sm:block">
              <LanguageSelector />
            </div>

            {/* Dark Mode Toggle — hidden entirely when an admin has locked
                the instance to a specific mode via Branding > Force color mode. */}
            {!forcedMode && (
              <button
                onClick={toggleDarkMode}
                className="p-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                title={isDark ? t('admin.lightMode', 'Switch to light mode') : t('admin.darkMode', 'Switch to dark mode')}
              >
                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
            )}

            {/* Notifications */}
            <div className="relative" ref={notificationRef}>
              <button
                onClick={notificationsModal.toggle}
                className="relative p-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
                )}
              </button>

              {/* Notifications dropdown */}
              {notificationsModal.isOpen && (
                <div className="absolute right-0 mt-2 w-96 bg-white dark:bg-neutral-800 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-700">
                  <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-700 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('admin.notifications')}</h3>
                    <div className="flex items-center gap-2">
                      {unreadCount > 0 && (
                        <button
                          onClick={() => markAllAsReadMutation.mutate()}
                          className="text-xs text-accent hover:opacity-80 flex items-center gap-1"
                          title={t('admin.markAllRead')}
                        >
                          <CheckCircle className="w-3 h-3" />
                          {t('admin.markAllRead')}
                        </button>
                      )}
                      <button
                        onClick={() => clearAllMutation.mutate()}
                        className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 flex items-center gap-1"
                        title={t('admin.clearAll')}
                      >
                        <Trash2 className="w-3 h-3" />
                        {t('admin.clearAll')}
                      </button>
                    </div>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                        {t('admin.noNotificationsMessage')}
                      </div>
                    ) : (
                      notifications.map((notification) => {
                        const style = notificationsService.getNotificationStyle(notification.type);
                        return (
                          <div
                            key={notification.id}
                            className={`px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-700 cursor-pointer border-l-4 ${
                              notification.isRead ? 'border-transparent opacity-75' : 'border-accent-dark'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <div className={`mt-0.5 ${style.color}`}>
                                <Bell className="w-4 h-4" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-neutral-900 dark:text-neutral-100">
                                  {notificationsService.formatNotificationMessage(notification)}
                                </p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                                  {formatDistanceToNow(notification.createdAt, { addSuffix: true })}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {notifications.length > 0 && (
                    <div className="px-4 py-2 border-t border-neutral-100 dark:border-neutral-700 text-center">
                      <button
                        onClick={notificationsModal.close}
                        className="text-sm text-accent hover:opacity-80"
                      >
                        {t('admin.close')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* User menu */}
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={userMenuModal.toggle}
                className="flex items-center gap-3 p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
              >
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{user?.username}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{user?.email}</p>
                </div>
                <div className="w-8 h-8 bg-accent-dark rounded-full flex items-center justify-center">
                  <User className="w-5 h-5 text-white" />
                </div>
              </button>

              {/* User dropdown */}
              {userMenuModal.isOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-neutral-800 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-700 py-1">
                  <div className="px-4 py-2 border-b border-neutral-100 dark:border-neutral-700 sm:hidden">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{user?.username}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{user?.email}</p>
                  </div>
                  {/* Language sub-section — phone-only (#523 follow-up).
                      Rekoo-PS asked for language to live inside the profile
                      menu since it's a set-once preference; on sm+ it
                      stays in the header cluster where it's been. Collapsible
                      so the menu isn't 8 rows taller by default. */}
                  <div className="sm:hidden border-b border-neutral-100 dark:border-neutral-700">
                    <button
                      onClick={userMenuLangSectionModal.toggle}
                      className="w-full px-4 py-2 text-left text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3"
                      aria-expanded={userMenuLangSectionModal.isOpen}
                    >
                      <Globe className="w-4 h-4" />
                      <span className="flex-1">{t('common.language', 'Language')}</span>
                      <currentLanguage.Flag className="w-4 h-4" />
                      <ChevronDown className={`w-4 h-4 transition-transform ${userMenuLangSectionModal.isOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {userMenuLangSectionModal.isOpen && (
                      <div className="bg-neutral-50 dark:bg-neutral-900 py-1">
                        {SUPPORTED_LANGUAGES.map((language) => (
                          <button
                            key={language.code}
                            onClick={() => handleUserMenuLangSelect(language.code)}
                            className={`w-full pl-11 pr-4 py-2 text-left text-sm flex items-center gap-3 hover:bg-neutral-100 dark:hover:bg-neutral-700 ${
                              language.code === i18n.language
                                ? 'text-accent bg-accent-dark/15'
                                : 'text-neutral-700 dark:text-neutral-300'
                            }`}
                          >
                            <language.Flag className="w-4 h-4" />
                            <span>{language.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      closeUserMenu();
                      navigate('/admin/settings');
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3"
                  >
                    <Settings className="w-4 h-4" />
                    {t('navigation.settings')}
                  </button>
                  <button
                    onClick={() => {
                      closeUserMenu();
                      passwordModal.open();
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3"
                  >
                    <Lock className="w-4 h-4" />
                    {t('admin.changePassword')}
                  </button>
                  <button
                    onClick={handleLogout}
                    className="w-full px-4 py-2 text-left text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3"
                  >
                    <LogOut className="w-4 h-4" />
                    {t('common.logout')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Password Change Modal */}
      <PasswordChangeModal
        isOpen={passwordModal.isOpen}
        onClose={passwordModal.close}
      />
    </header>
  );
};
