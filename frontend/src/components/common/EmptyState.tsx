import React from 'react';
import clsx from 'clsx';
import { AlertCircle, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** What is missing and why it matters, one or two lines. */
  description?: React.ReactNode;
  /** The next step: "Upload photos", "Create a quote". */
  action?: React.ReactNode;
  /** `inline` inside a card; `page` (default) for a whole view. */
  size?: 'inline' | 'page';
  className?: string;
}

/** "There is nothing here yet" — say what is missing and offer the next step (UX.md § 4). */
export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action, size = 'page', className }) => (
  <div className={clsx('flex flex-col items-center text-center', size === 'page' ? 'py-16 px-4' : 'py-8 px-4', className)}>
    {icon && <div className="mb-3 text-faint [&>svg]:w-10 [&>svg]:h-10" aria-hidden="true">{icon}</div>}
    <p className="text-base font-medium text-heading">{title}</p>
    {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
    {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>
);

interface ErrorStateProps {
  /** "Couldn't load the invoices". */
  title?: React.ReactNode;
  /** The server's message when there is one. */
  message?: React.ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  size?: 'inline' | 'page';
  className?: string;
}

/**
 * "Loading failed" — never the empty state: "couldn't load" and "there is
 * nothing" are different messages. Always offers Retry (UX.md § 4).
 */
export const ErrorState: React.FC<ErrorStateProps> = ({ title, message, onRetry, retrying = false, size = 'page', className }) => {
  const { t } = useTranslation();
  return (
    <div role="alert" className={clsx('flex flex-col items-center text-center', size === 'page' ? 'py-16 px-4' : 'py-8 px-4', className)}>
      <AlertCircle className="mb-3 w-10 h-10 text-danger-text" aria-hidden="true" />
      <p className="text-base font-medium text-heading">{title ?? t('common.loadFailed', 'Could not load this')}</p>
      {message && <p className="mt-1 max-w-md text-sm text-muted">{message}</p>}
      {onRetry && (
        <Button className="mt-4" variant="outline" size="sm" onClick={onRetry} isLoading={retrying} leftIcon={<RotateCw className="w-4 h-4" />}>
          {t('common.retry', 'Retry')}
        </Button>
      )}
    </div>
  );
};
