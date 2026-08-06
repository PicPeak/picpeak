import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AlertCircle, Check, Clock, Copy } from 'lucide-react';
import { differenceInDays, parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../hooks/useLocalizedDate';
import { usePublicSettings } from '../hooks/usePublicSettings';

import { Card, CardContent, Input, Button, ReCaptcha, CMSContentBlock, PoweredBy } from '../components/common';
import { useGalleryAuth, useTheme } from '../contexts';
import { useGalleryInfo } from '../hooks/useGallery';
import { GalleryView } from '../components/gallery';
import { GallerySkeleton } from '../components/gallery/GallerySkeleton';
import { analyticsService } from '../services/analytics.service';
import { galleryService } from '../services';
import { GALLERY_THEME_PRESETS } from '../types/theme.types';
import { buildResourceUrl } from '../utils/url';
import { isGalleryPublic, normalizeRequirePassword } from '../utils/accessControl';
import { detectInAppBrowser } from '../utils/inAppBrowser';

export const GalleryPage: React.FC = () => {
  const { slug: rawSlug, token: rawToken } = useParams<{ slug: string; token?: string }>();
  const { isAuthenticated, login, event } = useGalleryAuth();
  const { t, i18n } = useTranslation();
  const { format } = useLocalizedDate();
  const { setTheme } = useTheme();
  const [password, setPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
  // #868 admin preview: signalled by ?admin_preview=1 in the (dedicated) gallery
  // tab URL. It renders the gallery directly with NO gallery session — the
  // backend grants each request per the flag + admin cookie. We must skip the
  // public empty-password auto-login below, which would otherwise POST an empty
  // password against a genuinely protected gallery and 401 (#981 review).
  const isAdminPreview = React.useMemo(
    () => new URLSearchParams(window.location.search).get('admin_preview') === '1',
    [],
  );
  // Evaluate once per mount — UA doesn't change at runtime, and using useMemo
  // avoids re-running detection on every render of the form.
  const iabDetection = React.useMemo(() => detectInAppBrowser(), []);
  // Field reports on #654 show the password form failing inside Instagram's
  // IAB even with the input-attribute/trim defenses, so the form is hidden
  // there by default. `iabOverride` is the guest's escape hatch (also covers
  // a UA-detection false positive, or Instagram fixing their webview).
  const [iabOverride, setIabOverride] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const iabBlocked = iabDetection.app === 'instagram' && !iabOverride;
  const [resolvedSlug, setResolvedSlug] = useState<string | null>(() => {
    if (rawSlug && !rawToken && /^[0-9a-fA-F]{32}$/.test(rawSlug)) {
      return null;
    }
    return rawSlug || null;
  });
  const [resolvedToken, setResolvedToken] = useState<string | undefined>(rawToken);
  const [isResolvingIdentifier, setIsResolvingIdentifier] = useState<boolean>(() =>
    Boolean(rawSlug && !rawToken && /^[0-9a-fA-F]{32}$/.test(rawSlug))
  );
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const lastResolvedIdentifier = React.useRef<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    const looksLikeToken = Boolean(rawSlug && !rawToken && /^[0-9a-fA-F]{32}$/.test(rawSlug));

    if (!rawSlug) {
      lastResolvedIdentifier.current = null;
      setResolvedSlug(null);
      setResolvedToken(rawToken);
      setIsResolvingIdentifier(false);
      setIdentifierError(null);
    } else if (!looksLikeToken) {
      lastResolvedIdentifier.current = null;
      setResolvedSlug(rawSlug);
      setResolvedToken(rawToken);
      setIsResolvingIdentifier(false);
      setIdentifierError(null);
    } else if (lastResolvedIdentifier.current !== rawSlug) {
      setIsResolvingIdentifier(true);
      setIdentifierError(null);

      galleryService.resolveIdentifier(rawSlug)
        .then((data) => {
          if (cancelled) return;
          lastResolvedIdentifier.current = rawSlug;
          setResolvedSlug(data.slug);
          setResolvedToken(data.token);
          setIdentifierError(null);
        })
        .catch((error: any) => {
          if (cancelled) return;
          lastResolvedIdentifier.current = rawSlug;
          setResolvedSlug(null);
          setResolvedToken(undefined);
          const message = error?.response?.data?.error || 'Unable to resolve gallery link';
          setIdentifierError(message);
        })
        .finally(() => {
          if (!cancelled) {
            setIsResolvingIdentifier(false);
          }
        });
    } else {
      setIsResolvingIdentifier(false);
    }

    return () => {
      cancelled = true;
    };
  }, [rawSlug, rawToken]);

  const canFetchGalleryInfo = Boolean(resolvedSlug) && !isResolvingIdentifier;
  const {
    data: galleryInfo,
    isLoading: isLoadingInfoQuery,
    error: infoError
  } = useGalleryInfo(canFetchGalleryInfo ? resolvedSlug ?? undefined : undefined, resolvedToken, canFetchGalleryInfo);
  const isLoadingInfo = isLoadingInfoQuery || isResolvingIdentifier;
  const requiresPassword = normalizeRequirePassword(galleryInfo?.requires_password, true);

  React.useEffect(() => {
    setAutoLoginAttempted(false);
  }, [resolvedSlug]);
  
  const { data: settingsData, isLoading: isLoadingSettings } = usePublicSettings();
  
  // Set language from admin settings when on login page
  React.useEffect(() => {
    if (!isAuthenticated && settingsData?.default_language) {
      i18n.changeLanguage(settingsData.default_language);
    }
  }, [settingsData, isAuthenticated, i18n]);

  // Apply theme for gallery (both login page and authenticated view)
  React.useEffect(() => {
    if (galleryInfo && settingsData) {
      let themeToApply = null;

      if (galleryInfo.color_theme) {
        try {
          // Check if it's a valid JSON string
          if (galleryInfo.color_theme.startsWith('{')) {
            themeToApply = JSON.parse(galleryInfo.color_theme);
          } else {
            // Handle legacy theme names - check if it's a preset
            const preset = GALLERY_THEME_PRESETS[galleryInfo.color_theme];
            if (preset) {
              themeToApply = preset.config;
            } else {
              // Unknown theme name, fall back to global theme
              if (settingsData.theme_config) {
                themeToApply = settingsData.theme_config;
              }
            }
          }
        } catch (e) {
          console.error('Failed to parse event theme:', e);
          // Fall back to global theme
          if (settingsData.theme_config) {
            themeToApply = settingsData.theme_config;
          }
        }
      } else if (settingsData.theme_config) {
        // No event theme, use global theme
        themeToApply = settingsData.theme_config;
      }

      // Inject hero photo ID into theme gallery settings
      if (themeToApply && galleryInfo.hero_photo_id) {
        if (themeToApply.gallerySettings) {
          themeToApply.gallerySettings.heroImageId = galleryInfo.hero_photo_id;
        } else {
          themeToApply.gallerySettings = { heroImageId: galleryInfo.hero_photo_id };
        }
      }

      // Apply theme. Force color mode is enforced inside ThemeContext.applyTheme
      // (it subscribes to public settings) so callers don't have to wrap the
      // theme themselves — keeps the lock consistent across every entry point.
      if (themeToApply) {
        setTheme(themeToApply);
      }
    }
  }, [galleryInfo, settingsData, setTheme]);

  React.useEffect(() => {
    if (!resolvedSlug || isResolvingIdentifier) {
      return;
    }

    if (galleryInfo && !isAdminPreview && isGalleryPublic(galleryInfo.requires_password) && !isAuthenticated && !autoLoginAttempted && !isLoadingSettings) {
      setAutoLoginAttempted(true);
      setIsLoggingIn(true);
      login(resolvedSlug, '')
        .then(() => {
          setLoginError(null);
        })
        .catch((error: any) => {
          const message = error?.response?.data?.error;
          if (message) {
            setLoginError(message);
          }
        })
        .finally(() => {
          setIsLoggingIn(false);
        });
    }
  }, [galleryInfo, isAdminPreview, isAuthenticated, autoLoginAttempted, login, resolvedSlug, isResolvingIdentifier, isLoadingSettings]);

  // Calculate days until expiration (null if no expiration set)
  const daysUntilExpiration = galleryInfo?.expires_at
    ? differenceInDays(parseISO(galleryInfo.expires_at), new Date())
    : null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent any bubbling
    
    if (requiresPassword && !password.trim()) {
      setLoginError(t('auth.pleaseEnterPassword'));
      return;
    }

    try {
      setIsLoggingIn(true);
      setLoginError(null);
      if (!resolvedSlug) {
        setLoginError(t('errors.galleryNotFound'));
        return;
      }

      // Trim the password before sending. The Instagram in-app browser's
      // predictive-text keyboard frequently appends a trailing space when the
      // user taps the submit button, which then fails byte-exact bcrypt
      // compare on the backend with no visible cause (#654). Mid-string
      // invisible Unicode from chat-app copy-paste is handled server-side as
      // a same-request compare fallback (see auth.js gallery/verify).
      const submittedPassword = requiresPassword ? password.trim() : '';
      await login(resolvedSlug, submittedPassword, recaptchaToken);

      if (requiresPassword) {
        analyticsService.trackGalleryEvent('password_entry', {
          gallery: resolvedSlug,
          success: true
        });
      }
    } catch (error: any) {
      console.error('Login error:', error);
      const errorMessage = error.response?.data?.error || '';
      const statusCode = error.response?.status;

      // Map backend error messages to user-friendly translations
      if (!error.response) {
        // The request never got a response (offline, proxy/webview killed
        // it). Falling through to "incorrect password" here sent #654
        // reporters chasing the wrong cause — name the real failure.
        setLoginError(t('auth.networkError', 'Connection failed. Please check your internet connection and try again.'));
      } else if (statusCode === 400 && errorMessage.toLowerCase().includes('recaptcha')) {
        // reCAPTCHA rejection is not a wrong password either — the widget
        // regularly fails to load inside in-app webviews (#654).
        setLoginError(t('auth.recaptchaFailed', 'Security verification failed. Please reload the page and try again.'));
      } else if (statusCode === 401 || errorMessage.toLowerCase().includes('invalid password')) {
        setLoginError(t('auth.wrongPassword'));
      } else if (statusCode === 429 || errorMessage.toLowerCase().includes('too many')) {
        setLoginError(t('auth.tooManyAttempts'));
      } else if (statusCode === 404) {
        setLoginError(t('errors.galleryNotFound'));
      } else {
        setLoginError(t('auth.invalidPassword'));
      }
      
      // Track failed password entry
      if (requiresPassword) {
        analyticsService.trackGalleryEvent('password_entry', {
          gallery: resolvedSlug ?? rawSlug ?? 'unknown',
          success: false,
          statusCode
        });
      }
      
      // Keep the password field to allow retry
      // Do not clear the password
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleCopyLink = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
    } catch {
      // The async clipboard API is often unavailable inside in-app webviews —
      // fall back to the legacy textarea + execCommand path.
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        // execCommand signals failure via its return value, not by throwing —
        // only report "copied" when it actually worked; otherwise leave the
        // label unchanged and the user can still long-press the address bar.
        if (document.execCommand('copy')) {
          setLinkCopied(true);
        }
      } catch {
        // Same as a false return: keep the label unchanged.
      }
      document.body.removeChild(textarea);
    }
  };

  // Show the same skeleton GalleryView uses while photos load, so the
  // visitor sees one continuous loading state from URL open to real photos
  // instead of three different full-page interstitials (#321).
  if (isLoadingInfo) {
    return <GallerySkeleton />;
  }

  // Gallery missing / archived / expired-link / unresolvable identifier all
  // collapse into the customisable "gallery-not-found" CMS page (#324).
  // Admins can edit the title, body, and logo from the CMS Pages tab; the
  // seeded default copy is intentionally generic so any of those reasons
  // reads correctly.
  if (
    (identifierError && !resolvedSlug && !isResolvingIdentifier) ||
    infoError
  ) {
    return <CMSContentBlock slug="gallery-not-found" />;
  }

  // Show expired state
  if (galleryInfo?.is_expired) {
    return (
      <div className="min-h-screen" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
        <div className="min-h-screen flex flex-col">
          {/* Logo at top */}
          {settingsData?.branding_logo_url && (
            <div className="p-8 text-center">
              <img 
                src={buildResourceUrl(settingsData.branding_logo_url)} 
                alt={settingsData.branding_company_name || 'Company Logo'}
                className="h-16 w-auto object-contain mx-auto"
              />
            </div>
          )}
          
          <div className="flex-1 flex items-center justify-center">
            <Card className="max-w-md w-full mx-4">
              <CardContent className="text-center py-12">
                <Clock className="w-16 h-16 text-amber-500 mx-auto mb-4" />
                <h2 className="text-xl font-semibold mb-2">{t('gallery.expired')}</h2>
                {galleryInfo.expires_at && (
                  <p className="text-neutral-600 mb-4">
                    {t('gallery.expiredOn', { date: format(parseISO(galleryInfo.expires_at), 'PP') })}
                  </p>
                )}
                <p className="text-sm text-neutral-500">
                  {t('gallery.contactOrganizer')}
                </p>
              </CardContent>
            </Card>
          </div>
          
          {/* Legal Links */}
          <div className="p-8 text-center">
            <div className="flex items-center justify-center gap-4">
              <Link 
                to="/impressum" 
                className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
              >
                {t('legal.impressum')}
              </Link>
              <span className="text-xs text-neutral-400">|</span>
              <Link 
                to="/datenschutz" 
                className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
              >
                {t('legal.datenschutz')}
              </Link>
            </div>
            <PoweredBy className="text-xs mt-2 text-neutral-500" />
          </div>
        </div>
      </div>
    );
  }

  const gallerySlugForView = resolvedSlug ?? rawSlug ?? '';

  // Admin preview (#868): render the gallery directly, no gallery session.
  // GalleryView fetches photos by slug (the axios interceptor forwards
  // admin_preview=1 + the admin cookie), and reads its live event from that
  // response; this prop only seeds the initial header from /info.
  if (isAdminPreview && galleryInfo) {
    return (
      <GalleryView
        slug={gallerySlugForView}
        event={{
          id: 0,
          event_name: galleryInfo.event_name,
          event_type: galleryInfo.event_type,
          event_date: galleryInfo.event_date,
          color_theme: galleryInfo.color_theme,
          expires_at: galleryInfo.expires_at,
          allow_user_uploads: galleryInfo.allow_user_uploads,
          allow_downloads: galleryInfo.allow_downloads,
        }}
      />
    );
  }

  // Show gallery view if authenticated
  if (isAuthenticated && event) {
    return <GalleryView slug={gallerySlugForView} event={event} />;
  }

  // Public gallery: auto-login is in flight (or about to fire). Show the
  // skeleton instead of the "publicly accessible — loading photos" card so
  // visitors see one continuous skeleton until real photos appear (#321).
  if (!requiresPassword) {
    return <GallerySkeleton />;
  }

  // Show login form
  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-lg">
          {/* Logo/Header. The logo can be hidden per gallery (#894). */}
          <div className="text-center mb-4 sm:mb-6">
            {galleryInfo?.login_logo_visible !== false && (
              <img
                src={settingsData?.branding_logo_url ?
                  buildResourceUrl(settingsData.branding_logo_url) :
                  '/picpeak-logo-transparent.png'
                }
                alt={settingsData?.branding_company_name || 'PicPeak'}
                className="h-12 sm:h-16 lg:h-20 w-auto object-contain mx-auto mb-3 sm:mb-4"
              />
            )}
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-2 px-2" style={{ color: 'var(--color-primary, #5C8762)' }}>
              {galleryInfo?.event_name}
            </h1>
          </div>

          {/* Expiration Warning */}
          {daysUntilExpiration !== null && daysUntilExpiration <= 7 && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5 text-amber-600 mt-0.5 mr-2 flex-shrink-0" />
                <div>
                  <p className="text-xs sm:text-sm font-medium text-amber-800">
                    {t('gallery.expiresIn', { count: daysUntilExpiration })}
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    {t('gallery.downloadBefore')}
                  </p>
                </div>
              </div>
            </div>
          )}

          <Card>
            <CardContent className="p-4 sm:p-6">
              <h2 className="text-base sm:text-lg lg:text-xl font-semibold mb-4">{t('auth.enterPassword')}</h2>

              {/* Instagram in-app browser blocker (#654). Field reports show
                  password login failing inside the IAB even with the
                  input-attribute + trim defenses, so instead of a warning
                  above the form we replace the form: "open in your normal
                  browser" instructions plus a copy-link button. "Try anyway"
                  restores the form as an escape hatch (UA false positive, or
                  Instagram fixing their webview). */}
              {iabBlocked && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-900 dark:text-red-100"
                >
                  <div className="flex items-start">
                    <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 mr-2 flex-shrink-0" />
                    <div>
                      <p className="font-medium">
                        {t('auth.iab.instagram.blockedTitle', "Instagram's browser can't open this gallery")}
                      </p>
                      <p className="mt-1 text-xs">
                        {iabDetection.platform === 'ios'
                          ? t(
                            'auth.iab.instagram.blockedIos',
                            'Password login does not work reliably in Instagram\'s built-in browser. Tap the ⋯ menu in the top right and choose "Open in external browser", or copy the link and paste it into Safari.',
                          )
                          : t(
                            'auth.iab.instagram.blockedAndroid',
                            'Password login does not work reliably in Instagram\'s built-in browser. Tap the ⋮ menu in the top right and choose "Open in external browser", or copy the link and paste it into Chrome.',
                          )}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    className="w-full mt-4 text-sm sm:text-base"
                    onClick={handleCopyLink}
                    leftIcon={linkCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  >
                    {linkCopied
                      ? t('auth.iab.instagram.linkCopied', 'Link copied')
                      : t('auth.iab.instagram.copyLink', 'Copy link')}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setIabOverride(true)}
                    className="mt-3 w-full text-center text-xs text-red-800 dark:text-red-200 underline"
                  >
                    {t('auth.iab.instagram.tryAnyway', 'Try entering the password here anyway')}
                  </button>
                </div>
              )}

              {!iabBlocked && (
              <form onSubmit={handleLogin} className="space-y-4">
                <Input
                  type="password"
                  label={t('auth.password')}
                  placeholder={t('auth.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={loginError || undefined}
                  autoFocus
                  // Defend against in-app-browser keyboard mangling (#654):
                  //   - autoCapitalize: stop iOS autocaps turning `wedding2026`
                  //     into `Wedding2026` inside IAB WKWebViews
                  //   - autoCorrect / spellCheck: stop predictive-text rewrites
                  //   - autoComplete: tell password managers this is the
                  //     current-password slot so they autofill the right value
                  //     (vs the IAB's older saved-password store)
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="current-password"
                  className="text-sm sm:text-base"
                />

                <ReCaptcha
                  onChange={setRecaptchaToken}
                  onExpired={() => setRecaptchaToken(null)}
                />

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="w-full text-sm sm:text-base"
                  isLoading={isLoggingIn}
                  disabled={isLoggingIn}
                >
                  {t('gallery.viewGallery')}
                </Button>
              </form>
              )}

              {!iabBlocked && (
                <p className="text-xs text-neutral-500 text-center mt-4 sm:mt-6">
                  {t('auth.passwordHint')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Legal Links */}
          <div className="text-center mt-4 sm:mt-6">
            <div className="flex items-center justify-center gap-4">
              <Link 
                to="/impressum" 
                className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
              >
                {t('legal.impressum')}
              </Link>
              <span className="text-xs text-neutral-400">|</span>
              <Link 
                to="/datenschutz" 
                className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
              >
                {t('legal.datenschutz')}
              </Link>
            </div>
            <PoweredBy className="text-xs mt-2 text-neutral-500" />
          </div>
        </div>
      </div>
    </div>
  );
};
