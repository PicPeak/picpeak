import React from 'react';
import clsx from 'clsx';
import { CornerDownRight, Lock, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Switch } from './Switch';
import { StatusBadge, type FeatureStatus } from './StatusBadge';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  status: FeatureStatus;
  statusLabel: string;
  sidebarLabel?: string;
  sidebarHidden?: boolean;
  sidebarHiddenLabel?: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  lockedReason?: string;
  warning?: string;
  children?: React.ReactNode;
}

export const FeatureCard: React.FC<FeatureCardProps> = ({
  icon: Icon,
  title,
  description,
  status,
  statusLabel,
  sidebarLabel,
  sidebarHidden,
  sidebarHiddenLabel,
  enabled,
  onToggle,
  disabled = false,
  lockedReason,
  warning,
  children,
}) => (
  <li
    className={clsx(
      'rounded-xl border bg-white dark:bg-neutral-900 shadow-soft transition-colors',
      'border-neutral-200 dark:border-neutral-700',
      !disabled && 'hover:border-neutral-300 dark:hover:border-neutral-600',
    )}
  >
    <div className="flex items-start gap-4 p-5">
      {/* Icon tile — enabled state uses the admin's CI accent (via
          .bg-accent-soft + .text-on-accent-soft) so it follows the
          configured brand palette. The foreground token resolves to
          a high-contrast colour in both light and dark mode. */}
      <div
        className={clsx(
          'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
          enabled
            ? 'bg-accent-soft text-on-accent-soft'
            : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
        )}
      >
        <Icon className="w-5 h-5" />
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h4>
          <StatusBadge status={status} label={statusLabel} />
        </div>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{description}</p>

        {/* Sidebar callout */}
        <div className="mt-3 flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <CornerDownRight className="w-3.5 h-3.5" />
          {sidebarHidden ? (
            <span className="italic">{sidebarHiddenLabel}</span>
          ) : sidebarLabel ? (
            <>
              <span>Sidebar:</span>
              <span className="font-medium text-neutral-700 dark:text-neutral-300">{sidebarLabel}</span>
            </>
          ) : null}
        </div>

        {/* Locked-reason hint */}
        {lockedReason && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <Lock className="w-3.5 h-3.5 mt-0.5 text-amber-700 dark:text-amber-400 flex-shrink-0" />
            <span className="text-xs text-amber-800 dark:text-amber-300">{lockedReason}</span>
          </div>
        )}

        {/* Warning shown only when the user is about to disable (i.e. enabled=true).
            Wording assumes "you're disabling X — here's the consequence". */}
        {warning && enabled && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-amber-700 dark:text-amber-400 flex-shrink-0" />
            <span className="text-xs text-amber-800 dark:text-amber-300">{warning}</span>
          </div>
        )}

        {/* Sub-controls visible when enabled (e.g. Calendar mode radio) */}
        {enabled && children && (
          <div className="mt-4 pt-4 border-t border-neutral-100 dark:border-neutral-800">{children}</div>
        )}
      </div>

      {/* Toggle */}
      <Switch
        checked={enabled}
        disabled={disabled}
        onChange={onToggle}
        ariaLabel={title}
      />
    </div>
  </li>
);
