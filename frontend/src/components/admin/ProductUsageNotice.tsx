import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { usePermissions } from '../../contexts/PermissionsContext';
import { productUsageService } from '../../services/productUsage.service';

// Where the invitation is allowed to appear. It is an invitation, not an
// alert, so it belongs on the pages an admin visits deliberately rather than
// on top of whatever task they are in the middle of.
const NOTICE_PATHS = ['/admin/dashboard', '/admin/settings'];

// Loaded only inside the authenticated admin tree. Gallery routes never import
// this chunk, make usage requests, or record product usage markers.
export default function ProductUsageNotice() {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const { data } = useQuery({
    queryKey: ['productUsage'],
    queryFn: productUsageService.status,
    enabled: hasPermission('settings.edit')
  });
  // Deliberately above every visibility test, and deliberately NOT limited to
  // the pages the banner is shown on. This ticker is what triggers the daily
  // rollup — the backend has no scheduler — so tying it to the banner would
  // mean an admin who works on Events and never opens the dashboard stops
  // reporting altogether, and a participating install (where the banner never
  // renders at all) would never report again.
  useEffect(() => {
    let running = false;
    const tick = async () => {
      if (document.visibilityState === 'hidden' || running) return;
      running = true;
      try {
        await productUsageService.activity();
      } catch {
        /* Best-effort delivery; settings show persisted retry state. */
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  if (!hasPermission('settings.edit') || !data) return null;
  // Only while participation is off. `activation_pending`, `deletion_pending`
  // and `identity_conflict` are all in-flight states the settings page
  // explains properly; inviting someone to join in the middle of their own
  // withdrawal would be worse than saying nothing.
  if (data.status !== 'disabled' || data.notice_dismissed) return null;
  if (!NOTICE_PATHS.some((path) => pathname.startsWith(path))) return null;

  return (
    <aside
      className="mx-6 mt-4 rounded-lg border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/20 p-4"
      aria-label={t('productUsage.title')}
    >
      <div className="flex items-start gap-3">
        <Sparkles className="w-5 h-5 flex-shrink-0 mt-0.5 text-primary-600 dark:text-primary-300" />
        <div className="min-w-0 text-sm text-primary-900 dark:text-primary-100">
          <p className="font-medium">{t('productUsage.noticeTitle')}</p>
          <p className="mt-0.5 text-primary-800 dark:text-primary-200">
            {t('productUsage.notice')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Link
              className="font-medium underline hover:no-underline"
              to="/admin/settings?tab=usage"
            >
              {t('productUsage.review')}
            </Link>
            <button
              className="underline hover:no-underline"
              onClick={async () => {
                try {
                  queryClient.setQueryData(
                    ['productUsage'],
                    await productUsageService.dismiss()
                  );
                } catch {
                  /* The notice remains available. */
                }
              }}
            >
              {t('productUsage.ignore')}
            </button>
            {/* Dismissing is permanent — it sets notice_dismissed on the
                server, not a session flag — so the label says "Ignore" and
                this line says where to find it again. "Not now" implied the
                invitation would come back, and it never does. */}
            <span className="text-primary-700 dark:text-primary-300">
              {t('productUsage.ignoreHint')}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
