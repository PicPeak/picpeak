/**
 * The modal frame the contract screens share (#1445): version compare, the
 * edit-conflict compare and the pre-send review. A labelled dialog that
 * traps the focus, closes on Esc and gives the focus back to what opened it.
 */
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useFocusTrap } from '../../../hooks/useFocusTrap';

export const ContractModal: React.FC<{
  titleId: string;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width class. */
  width?: string;
}> = ({ titleId, title, onClose, children, footer, width = 'max-w-3xl' }) => {
  const { t } = useTranslation();
  const trap = useFocusTrap(true);
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);

  useEffect(() => {
    const returnTo = opener.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={trap} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`w-full ${width} max-h-[90vh] flex flex-col rounded-lg bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-xl`}>
        <div className="flex items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close', 'Close') as string}
            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
};
