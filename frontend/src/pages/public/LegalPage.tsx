import React, { useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Home } from 'lucide-react';
import DOMPurify from 'dompurify';
import { Loading, Card } from '../../components/common';
import { cmsService } from '../../services/cms.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import '../../styles/prose-overrides.css';

// Force rel="noopener noreferrer" on target="_blank" anchors in CMS-authored
// HTML so editors can't accidentally (or maliciously) introduce reverse
// tabnabbing via the legal pages.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// CMS-configured external_url may be edited by lower-privileged staff; reject
// anything outside http(s) so the legal route can't be turned into a
// javascript:/data: launcher.
const sanitizeExternalUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

export const LegalPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation();
  // Branding's palette in charge: Card and Loading follow it.
  usePublicDarkMode();
  const navigate = useNavigate();
  
  // Extract page slug from pathname if not in params (for static routes like /impressum)
  const pathname = window.location.pathname;
  const pageSlug = slug || pathname.split('/').pop() || '';
  
  const { data: settingsData } = usePublicSettings();

  // Use admin settings language
  const lang = settingsData?.default_language || 'en';

  // Fetch page content
  const { data: page, isLoading, error } = useQuery({
    queryKey: ['legal-page', pageSlug, lang],
    queryFn: () => cmsService.getPublicPage(pageSlug, lang),
    enabled: !!pageSlug && pageSlug !== '' && !!settingsData,
  });

  // Set i18n language when settings are loaded
  useEffect(() => {
    if (settingsData?.default_language) {
      i18n.changeLanguage(settingsData.default_language);
    }
  }, [settingsData, i18n]);

  // Update page title
  useEffect(() => {
    if (page?.title) {
      document.title = `${page.title} - PicPeak`;
    }
  }, [page?.title]);

  // External-URL override: full-page redirect so the visitor lands on the
  // operator's own canonical legal page. Use replace() so the back button
  // returns to the gallery instead of looping back through the redirect.
  const safeExternalUrl = page?.use_external_url && page?.external_url
    ? sanitizeExternalUrl(page.external_url)
    : null;
  const willRedirect = !!safeExternalUrl;
  useEffect(() => {
    if (safeExternalUrl) {
      window.location.replace(safeExternalUrl);
    }
  }, [safeExternalUrl]);

  if (isLoading || willRedirect) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loading size="lg" text={t('common.loading', 'Loading...')} />
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <div className="text-center py-12 px-6">
            <h2 className="text-xl font-semibold text-theme mb-2">{t('legal.notFoundTitle', 'Page not found')}</h2>
            <p className="text-muted-theme mb-6">
              {t('legal.notFoundBody', 'The page you are looking for does not exist.')}
            </p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-accent"
            >
              <Home className="w-4 h-4" />
              {t('legal.goHome', 'Go to the homepage')}
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-surface border-b border-border-token">
        <div className="container py-4">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 text-muted-theme hover:text-theme transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('common.back', 'Back')}
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="container py-12">
        <div className="max-w-4xl mx-auto">
          <Card padding="lg">
            <h1 className="text-3xl font-bold text-theme mb-8">{page.title}</h1>
            
            {/* `prose text-theme`: the CMS body takes the theme's text colour
                (styles/prose-overrides.css), so it reads on a light and a
                dark branding palette alike (QA S3). */}
            <div
              className="prose prose-neutral max-w-none text-theme"
              dangerouslySetInnerHTML={{ 
                __html: DOMPurify.sanitize(page.content, {
                  ALLOWED_TAGS: [
                    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                    'ul', 'ol', 'li', 'blockquote', 'a', 'em', 'strong',
                    'code', 'pre', 'hr', 'div', 'span'
                  ],
                  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
                  ALLOW_DATA_ATTR: false,
                  KEEP_CONTENT: true,
                  ADD_TAGS: ['br'], // Explicitly allow br tags
                  ADD_ATTR: ['style'], // Allow style for text alignment
                })
              }}
            />
            
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto py-8 border-t border-border-token">
        <div className="container text-center">
          <div className="flex justify-center gap-4 text-sm">
            <Link
              to="/impressum"
              className="text-muted-theme hover:text-theme"
            >
              {t('legal.impressum', 'Legal Notice')}
            </Link>
            <span className="text-muted-theme">•</span>
            <Link
              to="/datenschutz"
              className="text-muted-theme hover:text-theme"
            >
              {t('legal.datenschutz', 'Privacy Policy')}
            </Link>
          </div>
          <p className="text-sm text-muted-theme mt-4">
            {t('legal.copyright', '© {{year}} PicPeak. All rights reserved.', { year: new Date().getFullYear() })}
          </p>
        </div>
      </footer>
    </div>
  );
};