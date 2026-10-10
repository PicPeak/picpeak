import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { FeatureStatusBadge } from '../../features/featureStatus';
import type { FeatureKey } from '../../services/featureFlags.service';

interface SectionPageHeaderProps {
  title: string;
  description?: string;
  /** Usually the same icon the sidebar shows for this page. */
  icon?: LucideIcon;
  /** The feature this page belongs to: shows its state label (New, Beta,
   *  Experimental) from features/featureStatus/registry.ts, nothing when stable. */
  feature?: FeatureKey;
  /** Buttons / links rendered on the right; stacked under the title on phones. */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The one page header every section page (Settings, CRM, Accounting)
 * renders at the top, so the pages read as one product: icon + title
 * (+ feature-state label), optional one-line description, actions on the right.
 * Colours are explicit neutrals rather than `text-theme`: the gallery
 * branding theme sets --color-text on <html> and would bleed into the
 * admin chrome otherwise.
 */
export const SectionPageHeader: React.FC<SectionPageHeaderProps> = ({
  title,
  description,
  icon: Icon,
  feature,
  actions,
  className = 'mb-6',
}) => {
  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-6 h-6 flex-shrink-0 text-muted" />}
          <h1 className="text-2xl font-bold text-heading">{title}</h1>
          {feature && <FeatureStatusBadge feature={feature} />}
        </div>
        {description && (
          <p className="text-sm text-soft mt-1">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 flex-shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
};
