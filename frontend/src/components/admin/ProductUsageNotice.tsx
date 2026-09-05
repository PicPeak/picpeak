import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../contexts/PermissionsContext';
import { productUsageService } from '../../services/productUsage.service';

// Loaded only inside the authenticated admin tree. Gallery routes never import
// this chunk, make usage requests, or record product usage markers.
export default function ProductUsageNotice() {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['productUsage'],
    queryFn: productUsageService.status,
    enabled: hasPermission('settings.edit')
  });
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
  if (!hasPermission('settings.edit') || !data || data.status !== 'disabled' || data.notice_dismissed) return null;
  return (
    <aside
      className="mx-6 mt-4 rounded-lg border border-theme p-4 text-theme bg-theme-surface"
      aria-label={t('productUsage.title')}
    >
      <p>{t('productUsage.notice')}</p>
      <div className="mt-2 flex flex-wrap gap-4">
        <Link className="underline" to="/admin/settings?tab=usage">
          {t('productUsage.review')}
        </Link>
        <button
          className="underline"
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
          {t('productUsage.later')}
        </button>
      </div>
    </aside>
  );
}
