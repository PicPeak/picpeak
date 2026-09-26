import type { LucideIcon } from 'lucide-react';
import { ShieldOff, Users, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Shared invitation copy. Both entry points open the complete consent
// disclosure before enabling reporting.
export const USAGE_REPORTING_POINTS: { key: string; icon: LucideIcon }[] = [
  { key: 'oneWay', icon: ShieldOff },
  { key: 'mutual', icon: Users },
  { key: 'feedback', icon: MessageSquare },
];

export const UsageReportingPoints: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {USAGE_REPORTING_POINTS.map(({ key, icon: Icon }) => (
        <div key={key} className="flex items-start gap-3 rounded-lg border border-line p-3">
          <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--color-primary, #5C8762)' }} />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-body">
              {t(`setup.usageReporting.${key}Title`)}
            </span>
            <span className="block text-xs text-muted">
              {t(`setup.usageReporting.${key}Desc`)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
};
