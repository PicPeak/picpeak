import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, X } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Card';
import { pushDialogLayer } from './Modal';

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

// Outside the provider — only a component rendered on its own, as in a unit
// test — the question falls back to the browser's confirm. The app wraps
// everything in ConfirmDialogProvider, so users always get the dialog.
const browserConfirm = (options: ConfirmOptions): Promise<boolean> =>
  Promise.resolve(window.confirm(options.message));

export const useConfirm = (): ((options: ConfirmOptions) => Promise<boolean>) => {
  const ctx = useContext(ConfirmContext);
  return ctx ? ctx.confirm : browserConfirm;
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

  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!options) return;
    cancelButtonRef.current?.focus();
    const layer = pushDialogLayer();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      } else if (e.key === 'Enter') {
        // Enter on a focused button presses that button (Cancel has the focus
        // when the dialog opens), and never confirms from an editable field.
        // A destructive confirm only confirms from its own button: Enter
        // elsewhere does nothing, so a stray keypress can't delete.
        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (optionsRef.current?.variant === 'danger') return;
        e.preventDefault();
        settle(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      layer.release();
    };
  }, [options, settle]);

  const variant = options?.variant ?? 'primary';
  const Icon = variant === 'danger' ? AlertCircle : variant === 'warning' ? AlertTriangle : null;
  const iconClass =
    variant === 'danger'
      ? 'text-danger-text'
      : variant === 'warning'
        ? 'text-warning-text'
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
                  <h2 className="text-lg font-semibold text-heading mb-1">
                    {options.title}
                  </h2>
                )}
                <p className="text-sm text-body whitespace-pre-line break-words">
                  {options.message}
                </p>
              </div>
              <button
                onClick={() => settle(false)}
                className="text-faint hover:text-body"
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
                variant={variant === 'danger' ? 'danger' : 'primary'}
                onClick={() => settle(true)}
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
