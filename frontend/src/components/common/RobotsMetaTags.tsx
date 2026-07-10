import { useEffect } from 'react';
import { usePublicSettings } from '../../hooks/usePublicSettings';

export const RobotsMetaTags: React.FC = () => {
  const { data: settings } = usePublicSettings({ retry: false });

  useEffect(() => {
    // Remove any existing robots meta tags we previously injected
    document.querySelectorAll('meta[name="robots"][data-picpeak]').forEach(el => el.remove());

    const directives: string[] = [];
    if (settings?.seo_meta_noindex) directives.push('noindex');
    if (settings?.seo_meta_nofollow) directives.push('nofollow');

    if (directives.length > 0) {
      const meta = document.createElement('meta');
      meta.name = 'robots';
      meta.content = directives.join(', ');
      meta.setAttribute('data-picpeak', 'true');
      document.head.appendChild(meta);
    }

    if (settings?.seo_meta_noai) {
      const metaAi = document.createElement('meta');
      metaAi.name = 'robots';
      metaAi.content = 'noai, noimageai';
      metaAi.setAttribute('data-picpeak', 'true');
      document.head.appendChild(metaAi);
    }

    return () => {
      document.querySelectorAll('meta[name="robots"][data-picpeak]').forEach(el => el.remove());
    };
  }, [settings?.seo_meta_noindex, settings?.seo_meta_nofollow, settings?.seo_meta_noai]);

  return null;
};
