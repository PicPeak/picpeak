import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { useAnyPermission } from '../../hooks/usePermission';
import { systemHealthService } from '../../services/systemHealth.service';

export const DegradationBanner: React.FC = () => {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = React.useState(false);
  const canView = useAnyPermission(['settings.view', 'system.view']);

  const { data } = useQuery({
    queryKey: ['system-health-status'],
    queryFn: () => systemHealthService.getStatus(),
    enabled: canView,
    refetchInterval: 30000,
  });

  const limited = (data?.capabilities ?? []).some((capability) => capability.paused);
  // Dismissing covers this incident, not the next one.
  React.useEffect(() => {
    if (!limited) setDismissed(false);
  }, [limited]);
  if (!limited || dismissed) return null;

  return (
    <div role="status" className="bg-warning-soft border-b border-warning-line">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <AlertTriangle className="w-5 h-5 text-warning-text shrink-0" />
            <p className="text-sm font-medium text-warning-text">
              {t('systemHealth.dependencies.banner')}{' '}
              <Link to="/admin/settings?tab=health" className="underline">
                {t('systemHealth.dependencies.bannerLink')}
              </Link>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label={t('common.dismiss', 'Dismiss')}
            className="text-warning-text"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
