/**
 * Fixed guest entry page (issue 2495): /code, /code/:code and /code?code=.
 * One printed QR code points here for every event; the guest types the event
 * code and lands on the gallery's normal share link. The code is only a
 * lookup: a password gallery still asks for its password there.
 *
 * A code in the URL is filled in and submitted once. Looks like the gallery
 * password page (GalleryPage) so the guest sees one flow.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Input, Button, PoweredBy } from '../../components/common';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { useShowAgbLink } from '../../hooks/useShowAgbLink';
import { eventCodeService } from '../../services/eventCode.service';
import { buildResourceUrl } from '../../utils/url';
import { formatEventCode, isValidEventCode, normalizeEventCode } from '../../utils/eventCode';

export const EventCodePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { code: pathCode } = useParams<{ code?: string }>();
  const [searchParams] = useSearchParams();
  const initialCode = pathCode || searchParams.get('code') || '';
  const [value, setValue] = useState(() => formatEventCode(normalizeEventCode(initialCode)));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const autoSubmitted = useRef(false);
  const { data: settings } = usePublicSettings();
  const showAgb = useShowAgbLink();

  const submit = useCallback(async (typed: string) => {
    const code = normalizeEventCode(typed);
    if (!code) {
      setError(t('eventCode.required', 'Please enter your event code.'));
      return;
    }
    // A code that cannot exist never costs the guest one of their tries.
    if (!isValidEventCode(code)) {
      setError(t('eventCode.notFound', 'We could not find a gallery for this code. Please check it and try again.'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { path } = await eventCodeService.lookup(code);
      // Only ever a gallery on this site.
      if (typeof path === 'string' && path.startsWith('/gallery/')) {
        navigate(path, { replace: true });
        return;
      }
      setError(t('eventCode.notFound', 'We could not find a gallery for this code. Please check it and try again.'));
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setError(t('eventCode.notFound', 'We could not find a gallery for this code. Please check it and try again.'));
      } else if (status === 429) {
        setError(t('eventCode.tooManyAttempts', 'Too many attempts. Please wait a few minutes and try again.'));
      } else {
        setError(t('eventCode.failed', 'Something went wrong. Please try again.'));
      }
    } finally {
      setSubmitting(false);
    }
  }, [navigate, t]);

  useEffect(() => {
    if (autoSubmitted.current || !initialCode) return;
    autoSubmitted.current = true;
    void submit(initialCode);
  }, [initialCode, submit]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit(value);
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-lg">
          <div className="text-center mb-4 sm:mb-6">
            <img
              src={settings?.branding_logo_url ? buildResourceUrl(settings.branding_logo_url) : '/picpeak-logo-transparent.png'}
              alt={settings?.branding_company_name || 'PicPeak'}
              className="h-12 sm:h-16 lg:h-20 w-auto object-contain mx-auto mb-3 sm:mb-4"
            />
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-2 px-2" style={{ color: 'var(--color-accent-dark)' }}>
              {t('eventCode.title', 'Find your gallery')}
            </h1>
          </div>

          <div className="card-themed text-theme">
            <div className="p-4 sm:p-6">
              <h2 className="text-base sm:text-lg lg:text-xl font-semibold mb-4">
                {t('eventCode.subtitle', 'Enter the event code from your card or invitation.')}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <Input
                  themed
                  type="text"
                  label={t('eventCode.label', 'Event code')}
                  placeholder={t('eventCode.placeholder', 'e.g. K7M-4QX')}
                  value={value}
                  onChange={(e) => setValue(e.target.value.toUpperCase())}
                  error={error || undefined}
                  autoFocus
                  autoCapitalize="characters"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={24}
                  className="text-sm sm:text-base font-mono tracking-widest"
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="w-full text-sm sm:text-base"
                  isLoading={submitting}
                  disabled={submitting}
                >
                  {t('eventCode.submit', 'Open gallery')}
                </Button>
              </form>
              <p className="text-xs text-muted-theme text-center mt-4 sm:mt-6">
                {t('eventCode.hint', 'Upper or lower case does not matter. If the gallery has a password, you will be asked for it next.')}
              </p>
            </div>
          </div>

          <div className="text-center mt-4 sm:mt-6">
            <div className="flex items-center justify-center gap-4">
              <Link to="/impressum" className="text-xs text-muted-theme hover:text-theme transition-colors">
                {t('legal.impressum')}
              </Link>
              <span className="text-xs text-muted-theme">|</span>
              {showAgb && (
                <>
                  <Link to="/agb" className="text-xs text-muted-theme hover:text-theme transition-colors">
                    {t('legal.agb')}
                  </Link>
                  <span className="text-xs text-muted-theme">|</span>
                </>
              )}
              <Link to="/datenschutz" className="text-xs text-muted-theme hover:text-theme transition-colors">
                {t('legal.datenschutz')}
              </Link>
            </div>
            <PoweredBy className="text-xs mt-2 text-muted-theme" />
          </div>
        </div>
      </div>
    </div>
  );
};
