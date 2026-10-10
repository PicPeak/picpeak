import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { lockBodyScroll } from '../../utils/scrollLock';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** One line under the title: what this window is for. */
  description?: React.ReactNode;
  /** sm 28rem · md 32rem · lg 42rem · xl 56rem · 2xl 72rem */
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  /** Buttons, right-aligned; the primary action last. */
  footer?: React.ReactNode;
  /** A click on the backdrop closes (default). Turn off while a form is dirty. */
  closeOnBackdrop?: boolean;
  /** Focused on open instead of the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement>;
  /** The body scrolls on its own; header and footer stay. */
  children: React.ReactNode;
  className?: string;
}

const SIZES = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
  '2xl': 'sm:max-w-6xl',
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** FOCUSABLE scoped to one part of the dialog (no `:is()`: older Safari). */
const within = (scope: string) => FOCUSABLE.split(', ').map((sel) => `${scope} ${sel}`).join(', ');

/**
 * The one dialog window: backdrop, title, scrolling body, footer. Escape and
 * the close button close it, focus stays inside while open and returns to
 * the opener afterwards, and the page behind does not scroll. On a phone it
 * is a sheet from the bottom. For a yes/no question use `useConfirm()`.
 */
// Open dialogs, newest last. Keys go to the top one only: Escape on a confirm
// opened over a dialog closes the confirm, not both. Overlays that are not a
// Modal (the confirm dialog) join with pushDialogLayer.
const openStack: object[] = [];

/** Registers an open overlay; returns whether it is the top one, and a release. */
export function pushDialogLayer(): { isTop: () => boolean; release: () => void } {
  const token = {};
  openStack.push(token);
  return {
    isTop: () => openStack[openStack.length - 1] === token,
    release: () => { const i = openStack.indexOf(token); if (i >= 0) openStack.splice(i, 1); },
  };
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  closeOnBackdrop = true,
  initialFocusRef,
  children,
  className,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // The first field or button of the dialog's content, then its footer; the
    // header's close X only when the dialog has nothing else to focus.
    const first = initialFocusRef?.current
      ?? panel?.querySelector<HTMLElement>(within('[data-modal-body]'))
      ?? panel?.querySelector<HTMLElement>(within('[data-modal-footer]'))
      ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
      ?? panel;
    first?.focus();

    const unlockScroll = lockBodyScroll();

    const layer = pushDialogLayer();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      layer.release();
      unlockScroll();
      opener?.focus?.();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={clsx(
          'w-full max-h-[90vh] flex flex-col bg-panel border border-line shadow-xl outline-none',
          'rounded-t-xl sm:rounded-xl',
          SIZES[size],
          className,
        )}
      >
        <div className="flex items-start gap-3 px-6 py-4 border-b border-line">
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-heading">{title}</h2>
            {description && <p id={descriptionId} className="text-sm text-muted mt-0.5">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 p-2 rounded-lg text-faint hover:text-body hover:bg-hover"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div data-modal-body className="flex-1 min-h-0 overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <div data-modal-footer className="flex flex-wrap justify-end gap-2 px-6 py-4 border-t border-line">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
};
