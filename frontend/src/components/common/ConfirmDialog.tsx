import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, X } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Card';

/**
 * Promise-based confirm dialog (#640 part C, ported from 8digit/picpeak@88bfde1).
 *
 * Replaces `window.confirm()` with a styled, themed, accessible in-app modal.
 * Usage:
 *
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: 'Delete event?',
 *     message: 'This will permanently remove the gallery and all photos.',
 *     variant: 'danger',
 *     confirmLabel: 'Delete',
 *   });
 *   if (ok) doDelete();
 *
 * Wraps once at the App level via <ConfirmDialogProvider />; every component
 * below it gets `useConfirm()` for free. Variants:
 *   - 'primary' (default) — plain confirm, no icon
 *   - 'danger'            — red AlertCircle, red confirm button
 *   - 'warning'           — amber AlertTriangle
 *
 * Keyboard: Escape cancels, Enter confirms, backdrop click cancels. The cancel
 * button is focused by default so a stray Enter doesn't accidentally confirm a
 * destructive action.
 *
 * This is the generic primitive. Existing inline-modal flows (PublishGalleryDialog,
 * DuplicateEventDialog, PasswordResetModal, etc.) stay as-is — they collect
 * structured input, not a simple yes/no. Call-site sweeps of `window.confirm()`
 * follow in later PRs.
 */

export type ConfirmVariant = 'primary' | 'danger' | 'warning';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

type Resolver = (value: boolean) => void;

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export const useConfirm = (): ((options: ConfirmOptions) => Promise<boolean>) => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within a ConfirmDialogProvider');
  }
  return ctx.confirm;
};

export const ConfirmDialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // If a prior confirm is still open (shouldn't happen in practice but
      // guard anyway), resolve it as cancelled before opening the new one.
      if (resolverRef.current) {
        resolverRef.current(false);
      }
      resolverRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    if (resolverRef.current) {
      resolverRef.current(value);
      resolverRef.current = null;
    }
    setOptions(null);
  }, []);

  useEffect(() => {
    if (!options) return;
    cancelButtonRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      } else if (e.key === 'Enter') {
        // Don't hijack Enter when the focus is in an editable element — covers
        // the (unusual) case where a confirm is open over an open input.
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        settle(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [options, settle]);

  const variant = options?.variant ?? 'primary';
  const Icon = variant === 'danger' ? AlertCircle : variant === 'warning' ? AlertTriangle : null;
  const iconClass =
    variant === 'danger'
      ? 'text-red-600 dark:text-red-400'
      : variant === 'warning'
        ? 'text-amber-600 dark:text-amber-400'
        : '';

  // Danger uses the outline button + an inline red override so the visual
  // weight matches the action without redefining a Button variant for one case.
  const confirmButtonVariant: 'primary' | 'outline' = variant === 'danger' ? 'outline' : 'primary';
  const confirmButtonClass = variant === 'danger'
    ? 'bg-red-600 hover:bg-red-700 text-white border-red-600'
    : '';

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {options && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
          onClick={() => settle(false)}
          role="dialog"
          aria-modal="true"
        >
          <Card
            className="max-w-md w-full"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              {Icon && <Icon className={`w-6 h-6 flex-shrink-0 mt-0.5 ${iconClass}`} />}
              <div className="flex-1 min-w-0">
                {options.title && (
                  <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
                    {options.title}
                  </h2>
                )}
                <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-line break-words">
                  {options.message}
                </p>
              </div>
              <button
                onClick={() => settle(false)}
                className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                aria-label={t('common.close', 'Close')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex gap-2 justify-end">
              <Button
                ref={cancelButtonRef}
                variant="outline"
                onClick={() => settle(false)}
              >
                {options.cancelLabel ?? t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant={confirmButtonVariant}
                onClick={() => settle(true)}
                className={confirmButtonClass}
              >
                {options.confirmLabel ?? t('common.confirm', 'Confirm')}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};
