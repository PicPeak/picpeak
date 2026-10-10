import React from 'react';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { CornerDownRight, Lock, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Switch } from './Switch';
import { FeatureStatusBadge } from '../../featureStatus';
import { Notice } from '../../../components/common';
import type { FeatureKey } from '../../../services/featureFlags.service';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Its state label comes from features/featureStatus/registry.ts. */
  feature: FeatureKey;
  sidebarLabel?: string;
  sidebarHidden?: boolean;
  sidebarHiddenLabel?: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /**
   * Where this feature is configured, shown as a link once it is switched on.
   * Settings is long enough that "I enabled it, now where do I set it up?" is
   * a real question, and the Features list is the one page that knows the
   * answer for every feature. Omitted for features with nothing to configure.
   */
  configureHref?: string;
  /** Required alongside `configureHref` — the label is user-visible, so it has
   *  no sensible untranslated default. */
  configureLabel?: string;
  disabled?: boolean;
  lockedReason?: string;
  warning?: string;
  children?: React.ReactNode;
}

export const FeatureCard: React.FC<FeatureCardProps> = ({
  icon: Icon,
  title,
  description,
  feature,
  sidebarLabel,
  sidebarHidden,
  sidebarHiddenLabel,
  enabled,
  onToggle,
  configureHref,
  configureLabel,
  disabled = false,
  lockedReason,
  warning,
  children,
}) => (
  <li
    className={clsx(
      'rounded-xl border bg-shell shadow-soft transition-colors',
      'border-line',
      !disabled && 'hover:border-line-strong',
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
            : 'bg-subtle text-muted',
        )}
      >
        <Icon className="w-5 h-5" />
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-semibold text-heading">{title}</h4>
          <FeatureStatusBadge feature={feature} />
        </div>
        <p className="mt-1 text-sm text-soft">{description}</p>

        {/* Sidebar callout */}
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <CornerDownRight className="w-3.5 h-3.5" />
          {sidebarHidden ? (
            <span className="italic">{sidebarHiddenLabel}</span>
          ) : sidebarLabel ? (
            <>
              <span>Sidebar:</span>
              <span className="font-medium text-body">{sidebarLabel}</span>
            </>
          ) : null}
        </div>

        {/* Locked-reason hint */}
        {lockedReason && (
          <Notice tone="warning" size="sm" className="mt-3" icon={<Lock className="w-3.5 h-3.5" />}>
            {lockedReason}
          </Notice>
        )}

        {/* Warning shown only when the user is about to disable (i.e. enabled=true).
            Wording assumes "you're disabling X — here's the consequence". */}
        {warning && enabled && (
          <Notice tone="warning" size="sm" className="mt-3">
            {warning}
          </Notice>
        )}

        {/* Only once the feature is on: before that the link would lead to a
            tab that is itself gated off by the flag. */}
        {enabled && configureHref && (
          <Link
            to={configureHref}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-dark hover:underline"
          >
            {configureLabel}
            <ArrowRight className="w-3 h-3" />
          </Link>
        )}

        {/* Sub-controls visible when enabled (e.g. Calendar mode radio) */}
        {enabled && children && (
          <div className="mt-4 pt-4 border-t border-line-faint">{children}</div>
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
