import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SectionPageHeaderProps {
  title: string;
  description?: string;
  /** Usually the same icon the sidebar shows for this page. */
  icon?: LucideIcon;
  /** Marks a feature that works but whose surface is still evolving. */
  beta?: boolean;
  /** Buttons / links rendered on the right; stacked under the title on phones. */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The one page header every section page (Settings, CRM, Accounting)
 * renders at the top, so the pages read as one product: icon + title
 * (+ Beta badge), optional one-line description, actions on the right.
 * Colours are explicit neutrals rather than `text-theme`: the gallery
 * branding theme sets --color-text on <html> and would bleed into the
 * admin chrome otherwise.
 */
export const SectionPageHeader: React.FC<SectionPageHeaderProps> = ({
  title,
  description,
  icon: Icon,
  beta = false,
  actions,
  className = 'mb-6',
}) => {
  const { t } = useTranslation();
  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-6 h-6 flex-shrink-0 text-neutral-500 dark:text-neutral-400" />}
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{title}</h1>
          {beta && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          )}
        </div>
        {description && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{description}</p>
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
