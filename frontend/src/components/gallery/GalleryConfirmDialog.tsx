import React, { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';
import { useGalleryDialog } from './hooks/useGalleryDialog';

interface GalleryConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  /** `danger` for a step that removes something. */
  variant?: 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A yes/no question in the gallery. `useConfirm()` paints with the admin UI
 * tokens, which a gallery never switches to dark, so on a dark gallery theme
 * it would open as a white box; this one reads the theme tokens. Escape and
 * a click on the backdrop cancel, Cancel has the focus when it opens.
 */
export const GalleryConfirmDialog: React.FC<GalleryConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel,
  variant = 'primary',
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const messageId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useGalleryDialog({ open, onClose: onCancel, panelRef, initialFocusRef: cancelRef });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-3 sm:p-4 bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="card-themed text-theme w-full sm:max-w-md p-5 sm:p-6"
      >
        <h2 id={titleId} className="text-lg font-semibold text-theme">{title}</h2>
        <p id={messageId} className="mt-1 text-sm text-muted-theme whitespace-pre-line break-words">{message}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="outline" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant={variant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};
