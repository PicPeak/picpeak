import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { CMSPage } from '../../../services/cms.service';

type Titles = Pick<CMSPage, 'title_en' | 'title_de'>;

/**
 * A CMS page's name in the admin: the interface's own name for the pages it
 * knows (`legal.<slug>`), else the page's title in the interface language,
 * then its English title, then its address.
 */
export function cmsPageTitle(t: TFunction, language: string | undefined, slug: string, page?: Titles): string {
  const german = typeof language === 'string' && language.toLowerCase().startsWith('de');
  return t(`legal.${slug}`, { defaultValue: (german && page?.title_de) || page?.title_en || slug });
}

export function useCmsPageTitle(): (slug: string, page?: Titles) => string {
  const { t, i18n } = useTranslation();
  return (slug, page) => cmsPageTitle(t, i18n?.language, slug, page);
}
