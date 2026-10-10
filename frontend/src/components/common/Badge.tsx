import React from 'react';
import clsx from 'clsx';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'storno';

interface BadgeProps {
  /** What it means. Status colours always come with a word (STYLING.md). */
  tone?: BadgeTone;
  /** `soft` (default): tinted fill. `outline`: border only, for "not yet" states. */
  appearance?: 'soft' | 'outline';
  /** `caps`: small uppercase label (feature state, Default tag). */
  caps?: boolean;
  /** A leading dot in the tone's solid colour. */
  dot?: boolean;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

const SOFT: Record<BadgeTone, string> = {
  neutral: 'bg-inset text-soft',
  accent: 'bg-accent-soft text-on-accent-soft',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
  storno: 'bg-storno-soft text-storno-text',
};

const OUTLINE: Record<BadgeTone, string> = {
  neutral: 'border-line-strong text-muted',
  accent: 'border-accent-soft text-accent',
  success: 'border-success-line text-success-text',
  warning: 'border-warning-line text-warning-text',
  danger: 'border-danger-line text-danger-text',
  info: 'border-info-line text-info-text',
  storno: 'border-storno-line text-storno-text',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-fill-strong',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  storno: 'bg-storno',
};

/**
 * The one status pill of the admin: "Paid", "Draft", "Beta", "Default".
 * Colours come from tokens.css › Status (Branding › Colours), so they follow the
 * studio's status colours in light and dark. Portal and public pages use
 * `.status-chip` instead, which mixes the same hues into the themed surface.
 */
export const Badge: React.FC<BadgeProps> = ({
  tone = 'neutral',
  appearance = 'soft',
  caps = false,
  dot = false,
  icon,
  title,
  className,
  children,
}) => (
  <span
    title={title}
    className={clsx(
      'inline-flex items-center gap-1 rounded-full whitespace-nowrap',
      caps ? 'px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide' : 'px-2 py-0.5 text-xs font-medium',
      appearance === 'outline' ? ['border', OUTLINE[tone]] : SOFT[tone],
      className,
    )}
  >
    {dot && <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', DOT[tone])} aria-hidden="true" />}
    {icon && <span className="flex-shrink-0 [&>svg]:w-3 [&>svg]:h-3" aria-hidden="true">{icon}</span>}
    {children}
  </span>
);
