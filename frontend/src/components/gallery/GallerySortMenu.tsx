import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SortAsc, SortDesc } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';

export type GallerySortBy = 'date' | 'name' | 'size' | 'rating' | 'capture_date';

interface GallerySortMenuProps {
  sortBy: GallerySortBy;
  onSortChange: (sort: GallerySortBy) => void;
  // Sort direction (#889). Direction controls only render when the callback
  // is provided (PreviewPage doesn't pass it).
  sortDesc?: boolean;
  onSortDescChange?: (desc: boolean) => void;
  /** Called as the menu opens, so the toolbar can close its filter panel. */
  onOpen?: () => void;
  className?: string;
}

/**
 * The sort button and its menu, as the gallery toolbar and the theme preview
 * show it. Icon-only below md.
 */
export const GallerySortMenu: React.FC<GallerySortMenuProps> = ({
  sortBy,
  onSortChange,
  sortDesc = true,
  onSortDescChange,
  onOpen,
  className = '',
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The menu hangs from a sticky bar, so the page cannot scroll it into
  // view: on a short screen (a phone sideways) it scrolls within the room
  // left under the button instead.
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const bottom = buttonRef.current.getBoundingClientRect().bottom;
    setMaxHeight(Math.max(160, Math.floor(window.innerHeight - bottom - 16)));
  }, [open]);
  // A press or focus outside (the toolbar's Filters among them) and Escape
  // close the menu, so it never stays open over the filter panel.
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only an Escape meant for the menu or its toolbar, not one inside a
      // dialog above them.
      const active = document.activeElement;
      const scope = rootRef.current?.closest('.gallery-toolbar') ?? rootRef.current;
      if (active && active !== document.body && !scope?.contains(active)) return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  // The gallery.sortBy* strings are whole phrases ("Nach Datum sortieren"),
  // so they are used as they are rather than glued to "Sortieren nach".
  const sortButtonLabel =
    sortBy === 'date' ? t('gallery.sortByDate') :
    sortBy === 'name' ? t('gallery.sortByName') :
    sortBy === 'size' ? t('gallery.sortBySize') :
    sortBy === 'capture_date' ? t('gallery.sortByCaptureDate', 'Sort by Capture Date') :
    t('gallery.sortByRating', 'Sort by Rating');

  const options: Array<{ value: GallerySortBy; label: string }> = [
    { value: 'date', label: t('gallery.sortByDate') },
    { value: 'capture_date', label: t('photoSort.dateTaken', 'Date Taken') },
    { value: 'name', label: t('gallery.sortByName') },
    { value: 'size', label: t('gallery.sortBySize') },
    { value: 'rating', label: t('gallery.sortByRating', 'Sort by Rating') },
  ];

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <Button
        ref={buttonRef}
        variant="outline"
        size="md"
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        className="text-sm md:text-base px-2.5 md:px-4 gap-2 whitespace-nowrap"
        // Icon-only below md: the name must not depend on the hidden text.
        aria-label={sortButtonLabel}
        aria-expanded={open}
      >
        {/* Direction-aware icon only when the parent controls direction —
            PreviewPage renders the toolbar without it and sorts its own way. */}
        {onSortDescChange && sortDesc
          ? <SortDesc className="w-4 h-4 shrink-0" aria-hidden="true" />
          : <SortAsc className="w-4 h-4 shrink-0" aria-hidden="true" />}
        <span className="hidden md:inline">{sortButtonLabel}</span>
      </Button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-48 overflow-y-auto bg-surface rounded-lg shadow-lg border border-border-token py-1 z-10"
          style={{ maxHeight }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onSortChange(option.value);
                setOpen(false);
              }}
              className={`w-full text-left px-4 py-2 text-sm hover-surface ${
                sortBy === option.value ? 'bg-accent-dark text-accent-fg' : 'text-muted-theme'
              }`}
            >
              {option.label}
            </button>
          ))}

          {/* Sort direction (#889) */}
          {onSortDescChange && (
            <div className="border-t border-border-token mt-1 pt-1">
              <button
                onClick={() => {
                  onSortDescChange(false);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-2 text-sm hover-surface flex items-center gap-2 ${
                  !sortDesc ? 'bg-accent-dark text-accent-fg' : 'text-muted-theme'
                }`}
              >
                <SortAsc className="w-4 h-4" />
                {t('gallery.sortAscending', 'Sort ascending')}
              </button>
              <button
                onClick={() => {
                  onSortDescChange(true);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-2 text-sm hover-surface flex items-center gap-2 ${
                  sortDesc ? 'bg-accent-dark text-accent-fg' : 'text-muted-theme'
                }`}
              >
                <SortDesc className="w-4 h-4" />
                {t('gallery.sortDescending', 'Sort descending')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
