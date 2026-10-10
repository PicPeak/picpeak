import React from 'react';
import clsx from 'clsx';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export type NoticeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface NoticeProps {
  tone?: NoticeTone;
  title?: React.ReactNode;
  /** Replaces the tone's icon; `null` shows none. */
  icon?: React.ReactNode | null;
  /** A button or link. Shares a wrapping row with the text, so on a phone it
   *  drops under the text, lined up with it (STYLING.md › Layout). */
  action?: React.ReactNode;
  /** `sm` for a hint inside a form or card. */
  size?: 'sm' | 'md';
  className?: string;
  children?: React.ReactNode;
}

const BOX: Record<NoticeTone, string> = {
  neutral: 'bg-subtle border-line',
  info: 'bg-info-soft border-info-line',
  success: 'bg-success-soft border-success-line',
  warning: 'bg-warning-soft border-warning-line',
  danger: 'bg-danger-soft border-danger-line',
};

const ICON_COLOR: Record<NoticeTone, string> = {
  neutral: 'text-muted',
  info: 'text-info-text',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
};

const ICONS: Record<NoticeTone, React.ComponentType<{ className?: string }>> = {
  neutral: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
};

/**
 * A box that explains a state: "Read-only", "Expires in 3 days", "Import
 * failed". Text stays in the body colour so it reads on every tint; the
 * icon carries the tone. The action it calls for lives in the page header
 * when the header has one (UX.md § 1).
 */
export const Notice: React.FC<NoticeProps> = ({
  tone = 'info',
  title,
  icon,
  action,
  size = 'md',
  className,
  children,
}) => {
  const Icon = ICONS[tone];
  const shownIcon = icon === null ? null : icon ?? <Icon className={clsx('w-5 h-5', size === 'sm' && 'w-4 h-4')} />;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx(
        'flex items-start gap-3 rounded-lg border',
        size === 'sm' ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm',
        BOX[tone],
        className,
      )}
    >
      {shownIcon && <span className={clsx('flex-shrink-0 mt-px', ICON_COLOR[tone])} aria-hidden="true">{shownIcon}</span>}
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem] text-body">
          {title && <p className="font-medium text-heading">{title}</p>}
          {children && <div className={clsx(title && 'mt-0.5')}>{children}</div>}
        </div>
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
};
