import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { websiteService } from '../../services/website.service';

const QUERY_KEY = ['website-notice'];

/**
 * After the update that moved the single-page landing page into the website
 * builder (issue 2618, migration 381): where it went, once per admin, until
 * they dismiss it or the website is published.
 */
export default function WebsiteLandingNotice() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const enabled = useFeatureEnabled('websiteBuilder') && hasPermission('cms.view');
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: websiteService.getNotice, enabled, staleTime: 5 * 60 * 1000 });
  if (!enabled || !data?.legacyLanding) return null;

  const dismiss = async () => {
    try {
      await websiteService.dismissNotice();
      queryClient.setQueryData(QUERY_KEY, { legacyLanding: false });
    } catch {
      /* It stays until the next try. */
    }
  };

  return (
    <aside className="mx-6 mt-4 rounded-lg border border-accent-soft bg-accent-soft p-4" aria-label={t('websiteNotice.title', 'Your landing page moved')}>
      <div className="flex items-start gap-3">
        <Globe className="w-5 h-5 flex-shrink-0 mt-0.5 text-on-accent-soft" aria-hidden="true" />
        <div className="min-w-0 text-sm text-on-accent-soft">
          <p className="font-medium">{t('websiteNotice.title', 'Your landing page moved')}</p>
          <p className="mt-0.5">
            {t('websiteNotice.body', 'Your landing page now lives under Website. It still works as before: visitors see it unchanged. Review it in the new website builder and publish it there when you are ready.')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Link className="font-medium underline hover:no-underline" to="/admin/website">
              {t('websiteNotice.open', 'Open Website')}
            </Link>
            <button type="button" className="underline hover:no-underline" onClick={() => { void dismiss(); }}>
              {t('websiteNotice.dismiss', 'Dismiss')}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
