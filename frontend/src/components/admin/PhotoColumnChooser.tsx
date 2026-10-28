import React, { useEffect, useRef, useState } from 'react';
import { Check, Columns3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, useEscapeClose } from '../common';
import { PHOTO_LIST_COLUMNS, type PhotoListColumn } from '../../utils/photoViewPrefs';

interface PhotoColumnChooserProps {
  /** The column names to list, in table order. */
  labels: Record<PhotoListColumn, string>;
  hidden: readonly PhotoListColumn[];
  onToggle: (column: PhotoListColumn) => void;
}

/**
 * Show or hide the optional columns of the photo list (issue 1739). The menu
 * stays open while columns are toggled; Escape and a click outside close it.
 */
export const PhotoColumnChooser: React.FC<PhotoColumnChooserProps> = ({ labels, hidden, onToggle }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEscapeClose(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (current + 1) % items.length
          : (current <= 0 ? items.length : current) - 1;
    items[next]?.focus();
  };

  const label = t('admin.photos.columnChooser', 'Columns');
  return (
    <div className="relative" ref={ref}>
      <Button
        ref={triggerRef}
        variant="outline"
        size="icon-sm"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Columns3 className="w-4 h-4" />
      </Button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-1 z-30 w-56 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-panel shadow-lg p-1"
        >
          {PHOTO_LIST_COLUMNS.map((column) => {
            const shown = !hidden.includes(column);
            return (
              <button
                key={column}
                type="button"
                role="menuitemcheckbox"
                aria-checked={shown}
                onClick={() => onToggle(column)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left text-body hover:bg-hover"
              >
                <Check className={`w-4 h-4 shrink-0 ${shown ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
                {labels[column]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
