import { useEffect } from 'react';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { buildResourceUrl } from '../../utils/url';

const DEFAULT_TITLE = 'PicPeak - Photo Sharing Platform';

export const DynamicFavicon: React.FC = () => {
  const { data: settings } = usePublicSettings({ retry: false });

  // Update favicon when branding settings change
  useEffect(() => {
    if (settings?.branding_favicon_url) {
      // Remove existing favicon links
      const existingFavicons = document.querySelectorAll("link[rel*='icon']");
      existingFavicons.forEach(favicon => favicon.remove());

      // Create new favicon link. Derive the MIME type from the file
      // extension — hardcoding image/png made SVG (and .ico) favicons
      // get declared as PNG, which browsers reject (favicon didn't show).
      const href = settings.branding_favicon_url.startsWith('http')
        ? settings.branding_favicon_url
        : buildResourceUrl(settings.branding_favicon_url);
      const ext = href.split('?')[0].split('.').pop()?.toLowerCase();
      const typeByExt: Record<string, string> = {
        svg: 'image/svg+xml',
        png: 'image/png',
        ico: 'image/x-icon',
        gif: 'image/gif',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
      };

      const link = document.createElement('link');
      link.rel = 'icon';
      if (ext && typeByExt[ext]) link.type = typeByExt[ext];
      link.href = href;
      document.head.appendChild(link);

      // Safari uses apple-touch-icon for bookmarks / home-screen and is
      // unreliable about JS-injected rel="icon". The backend /favicon.ico +
      // /apple-touch-icon routes are the primary mechanism; this is
      // belt-and-braces for browsers that do read the DOM link.
      const appleLink = document.createElement('link');
      appleLink.rel = 'apple-touch-icon';
      appleLink.href = href;
      document.head.appendChild(appleLink);
    }
  }, [settings?.branding_favicon_url]);

  // Update document title and OG meta tags when company name or tagline changes
  useEffect(() => {
    const companyName = settings?.branding_company_name?.trim();
    const tagline = settings?.branding_company_tagline?.trim();

    if (companyName && tagline) {
      document.title = `${companyName} - ${tagline}`;
    } else if (companyName) {
      document.title = companyName;
    } else {
      document.title = DEFAULT_TITLE;
    }

    // Update OG meta tags
    const title = companyName || 'PicPeak';
    const description = tagline || 'Photo Sharing Platform';

    const updateMeta = (property: string, content: string) => {
      let meta = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null;
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('property', property);
        document.head.appendChild(meta);
      }
      meta.content = content;
    };

    updateMeta('og:title', document.title);
    updateMeta('og:site_name', title);
    updateMeta('og:description', description);

    // Also update standard meta description
    let metaDesc = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    if (!metaDesc) {
      metaDesc = document.createElement('meta');
      metaDesc.name = 'description';
      document.head.appendChild(metaDesc);
    }
    metaDesc.content = description;
  }, [settings?.branding_company_name, settings?.branding_company_tagline]);

  return null;
};
