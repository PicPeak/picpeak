import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGalleryDialog } from './hooks/useGalleryDialog';

interface GalleryBottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

// How far the sheet has to be pulled down before letting go closes it.
const DRAG_CLOSE_PX = 80;

/**
 * A bottom sheet for the gallery on a phone (issue 1733, E5): the filter
 * panel and the selection list open here instead of in a popover under the
 * toolbar. Focus moves in and stays inside, Escape, the backdrop and a pull
 * on the handle close it, the page behind does not scroll, and focus goes
 * back to the button that opened it (useGalleryDialog).
 */
export const GalleryBottomSheet: React.FC<GalleryBottomSheetProps> = ({ open, onClose, title, children }) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useGalleryDialog({ open, onClose, panelRef });
  const [dragY, setDragY] = useState(0);
  const dragStart = useRef<number | null>(null);

  if (!open) return null;

  // The drag starts on the handle and the title row only, so the sheet's own
  // content still scrolls.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragStart.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    setDragY(Math.max(0, e.clientY - dragStart.current));
  };
  const onPointerUp = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    const pulled = dragY;
    setDragY(0);
    if (pulled > DRAG_CLOSE_PX) onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" data-testid="sheet-backdrop" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-h-[85vh] flex flex-col rounded-t-2xl shadow-xl bg-surface text-theme"
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragY ? 'none' : 'transform 150ms ease-out',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div
          className="touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="sheet-handle"
        >
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-black/20" aria-hidden="true" />
          <div className="flex items-center justify-between px-4 pt-2 pb-3 border-b border-border-token">
            <h2 className="text-base font-semibold text-theme">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close', 'Close')}
              className="p-2 -m-2 rounded text-muted-theme hover-surface"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
};
