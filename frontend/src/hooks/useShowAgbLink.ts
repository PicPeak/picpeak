import { useQuery } from '@tanstack/react-query';
import { cmsService, type PublicCMSPage } from '../services/cms.service';

/**
 * Whether the footers link the AGB (terms and conditions) page.
 *
 * Opt-in, unlike Impressum and Datenschutz: the page ships hidden
 * (show_in_footer = false) because a placeholder terms page the operator
 * never wrote is worse than no link. The link appears only once the admin
 * has switched it on in CMS Pages — not while the page loads, on an error,
 * or on an install without the row. Shares the GalleryLayout query key, so
 * a page shows it with one request.
 */
export function useShowAgbLink(): boolean {
  const { data } = useQuery<PublicCMSPage>({
    queryKey: ['public-cms', 'agb'],
    queryFn: () => cmsService.getPublicPage('agb'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return data?.show_in_footer === true;
}
