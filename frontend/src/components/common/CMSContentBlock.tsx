import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { Card } from './Card';
import { Loading } from './Loading';
import { cmsService } from '../../services/cms.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { buildResourceUrl } from '../../utils/url';
import '../../styles/prose-overrides.css';

interface CMSContentBlockProps {
  /** CMS page slug, e.g. "not-found" or "gallery-not-found". */
  slug: string;
  /** Rendered when the slug doesn't exist or the fetch fails so the
   * caller is never left with a blank screen during cold deployments. */
  fallback?: React.ReactNode;
}

const ALLOWED_TAGS = [
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'a', 'em', 'strong',
  'code', 'pre', 'hr', 'div', 'span', 'img',
];
const ALLOWED_ATTR = ['href', 'target', 'rel', 'class', 'style', 'src', 'alt', 'title'];

/**
 * Renders a CMS page inside the standard branded shell. Used for the
 * customisable 404 and gallery-not-found pages (#324). Logo precedence:
 * per-page logo → global branding logo → bundled placeholder.
 */
export const CMSContentBlock: React.FC<CMSContentBlockProps> = ({ slug, fallback }) => {
  const { i18n } = useTranslation();

  const { data: settings } = usePublicSettings();

  const lang = settings?.default_language || i18n.language || 'en';

  const { data: page, isLoading, error } = useQuery({
    queryKey: ['cms-public-page', slug, lang],
    queryFn: () => cmsService.getPublicPage(slug, lang),
    enabled: !!slug,
    retry: false,
  });

  useEffect(() => {
    if (page?.title) document.title = `${page.title} - ${settings?.branding_company_name || 'PicPeak'}`;
  }, [page?.title, settings?.branding_company_name]);

  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: 'var(--color-background, #fafafa)' }}
      >
        <Loading size="lg" />
      </div>
    );
  }

  if (error || !page) {
    return <>{fallback ?? null}</>;
  }

  // Logo: per-page override beats global branding logo.
  const rawLogo = page.logo_url || settings?.branding_logo_url || '/picpeak-logo-transparent.png';
  const logoSrc = rawLogo.startsWith('http') || rawLogo.startsWith('/picpeak-')
    ? rawLogo
    : buildResourceUrl(rawLogo);
  const companyName = settings?.branding_company_name || 'PicPeak';

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
      <div className="p-8 text-center">
        <img
          src={logoSrc}
          alt={companyName}
          className="h-16 w-auto object-contain mx-auto"
        />
      </div>

      <main className="flex-1 flex items-start justify-center px-4">
        <div className="max-w-2xl w-full">
          <Card padding="lg">
            {/*
             * Heading + body now read from theme tokens so dark themes
             * (and force-dark mode) render correctly without dark: variants
             * fighting the CSS variables.
             */}
            <h1
              className="text-2xl sm:text-3xl font-bold mb-6"
              style={{ color: 'var(--color-text)' }}
            >
              {page.title}
            </h1>
            <div
              className="prose prose-neutral dark:prose-invert max-w-none"
              style={{ color: 'var(--color-text)' }}
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(page.content, {
                  ALLOWED_TAGS,
                  ALLOWED_ATTR,
                  ALLOW_DATA_ATTR: false,
                  KEEP_CONTENT: true,
                }),
              }}
            />
            <div className="mt-8">
              <Link
                to="/"
                className="text-sm font-medium hover:underline"
                style={{ color: 'var(--color-accent)' }}
              >
                {lang === 'de' ? '← Zur Startseite' : '← Back to home'}
              </Link>
            </div>
          </Card>
        </div>
      </main>

      <footer
        className="py-8 text-center text-xs"
        style={{ color: 'var(--color-muted-text)' }}
      >
        <div className="flex justify-center gap-4">
          <Link to="/impressum" className="hover:underline">
            {lang === 'de' ? 'Impressum' : 'Legal Notice'}
          </Link>
          <span style={{ color: 'var(--color-surface-border)' }}>•</span>
          <Link to="/datenschutz" className="hover:underline">
            {lang === 'de' ? 'Datenschutz' : 'Privacy Policy'}
          </Link>
        </div>
        {!settings?.branding_hide_powered_by && (
          <p className="mt-2">
            Powered by <span className="font-semibold">PicPeak</span>
          </p>
        )}
      </footer>
    </div>
  );
};
