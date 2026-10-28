import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { BulkRating } from './BulkRating';

interface BulkRatingPopoverProps {
  slug: string;
  photoIds: number[];
  requireNameEmail?: boolean;
  /** The wrapper the panel is placed against (from sm up, per the layout). */
  className?: string;
  /** The layout's own button look. */
  triggerClassName: string;
  /** Positions and paints the panel; the layout's stylesheet owns both. */
  popoverClassName: string;
  /** Next to the star, e.g. a label shown from sm up. */
  children?: React.ReactNode;
}

/**
 * "Rate selected" for the layouts that draw their own selection chrome
 * (Gallery Premium, Gallery Story; issue 1985): a star button that opens the
 * shared BulkRating in a small panel. Request, chunking, limits and cache
 * patching all stay in BulkRating; this only hosts it. A finished run is
 * confirmed with a toast, since Story tiles show no rating and Premium tiles
 * only the shared average.
 */
export const BulkRatingPopover: React.FC<BulkRatingPopoverProps> = ({
  slug,
  photoIds,
  requireNameEmail,
  className,
  triggerClassName,
  popoverClassName,
  children,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Held here: the panel unmounts BulkRating on every close.
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Read when a run finishes, which can be after the viewer dismissed the panel.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    // The name-and-email dialog is portalled to the body; a click in it is
    // not a click outside.
    if (!open || dialogOpen) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, dialogOpen]);

  const onRated = useCallback((count: number, rating: number) => {
    toast.success(rating > 0
      ? t('feedback.bulkRatingDone', { count, defaultValue: '{{count}} photos rated' })
      : t('feedback.bulkRatingCleared', { count, defaultValue: 'Rating removed from {{count}} photos' }));
    // Closing unmounts the focused star; hand focus back to the trigger so a
    // keyboard user keeps their place. A star disabled while the request ran
    // has already dropped focus to the body, so that counts too. Focus moved
    // to another control, or a panel the viewer already dismissed, is left
    // alone.
    const active = document.activeElement;
    if (openRef.current && (!active || active === document.body || rootRef.current?.contains(active))) {
      triggerRef.current?.focus();
    }
    setOpen(false);
  }, [t]);

  const label = t('feedback.rateSelected', 'Rate selected');
  return (
    <div
      ref={rootRef}
      className={className}
      // Tabbing out closes the panel so it does not sit over controls that
      // keep focus. A null target (a star disabled mid-request) is not an exit,
      // nor is the name-and-email dialog taking focus as it opens: that happens
      // before onDialogChange reports it.
      onBlur={(event) => {
        const next = event.relatedTarget as HTMLElement | null;
        if (!next || dialogOpen || rootRef.current?.contains(next)) return;
        if (next.closest?.('[aria-modal="true"]')) return;
        setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-testid="bulk-rating-trigger"
      >
        <Star size={14} aria-hidden="true" />
        {children}
      </button>
      {open && (
        <div className={popoverClassName} data-testid="bulk-rating-popover">
          <BulkRating
            slug={slug}
            photoIds={photoIds}
            requireNameEmail={requireNameEmail}
            onDialogChange={setDialogOpen}
            identity={identity}
            onIdentityChange={setIdentity}
            onRated={onRated}
          />
        </div>
      )}
    </div>
  );
};
