import React from 'react';
import clsx from 'clsx';

export type FeatureStatus = 'stable' | 'beta' | 'new' | 'experimental' | 'roadmap';

interface StatusBadgeProps {
  status: FeatureStatus;
  label: string;
}

const STATUS_STYLES: Record<FeatureStatus, string> = {
  stable:       'bg-neutral-100 text-neutral-600 border-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:border-neutral-700',
  beta:         'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800',
  new:          'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800',
  experimental: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
  roadmap:      'bg-white text-neutral-500 border-neutral-300 dark:bg-neutral-900 dark:text-neutral-400 dark:border-neutral-600',
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label }) => (
  <span
    className={clsx(
      'inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide',
      STATUS_STYLES[status],
    )}
  >
    {label}
  </span>
);
