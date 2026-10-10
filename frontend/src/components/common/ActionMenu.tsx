import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';

export interface ActionMenuItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Destructive: shown in the danger colour, after a divider. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ActionMenuProps {
  items: ActionMenuItem[];
  /** The side the dropdown is anchored to. */
  align?: 'left' | 'right';
  label?: string;
  /** Match the buttons next to it: `icon-sm` in a row of `sm` buttons. */
  size?: 'icon-sm' | 'icon-md';
  className?: string;
}

/**
 * The ⋯ menu of an entity header: the secondary actions, out of the way
 * (UX.md § 1). Escape and a click outside close it; an empty menu is not
 * rendered. Destructive items go last, after a divider.
 */
export const ActionMenu: React.FC<ActionMenuProps> = ({ items, align = 'right', label, size = 'icon-md', className }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The side the dropdown opens to, settled when it opens: `align` unless the
  // dropdown would leave the viewport on that side (on a phone the menu is
  // often the first item of a left-aligned row, so right-anchoring it would
  // push the dropdown off the left edge).
  const [side, setSide] = useState<'left' | 'right'>(align);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  const regular = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);
  const row = (item: ActionMenuItem) => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={() => { setOpen(false); item.onSelect(); }}
      className={clsx(
        'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left hover:bg-hover disabled:opacity-50 disabled:pointer-events-none',
        item.danger ? 'text-danger-text' : 'text-body',
        '[&>svg]:w-4 [&>svg]:h-4',
      )}
    >
      {item.icon}
      {item.label}
    </button>
  );
  return (
    <div className={clsx('relative', className)} ref={ref}>
      <Button
        variant="outline"
        size={size}
        aria-label={label || t('common.moreActions', 'More actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open && ref.current) {
            const box = ref.current.getBoundingClientRect();
            // No layout (width 0, e.g. while hidden): keep the requested side.
            const width = Math.min(256, window.innerWidth - 16);
            if (box.width === 0) setSide(align);
            else if (align === 'right' && box.right - width < 8) setSide('left');
            else if (align === 'left' && box.left + width > window.innerWidth - 8) setSide('right');
            else setSide(align);
          }
          setOpen((o) => !o);
        }}
      >
        <MoreHorizontal className="w-4 h-4" />
      </Button>
      {open && (
        <div
          role="menu"
          className={clsx(
            'absolute top-full mt-1 z-30 w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-panel shadow-lg p-1',
            side === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {regular.map(row)}
          {regular.length > 0 && danger.length > 0 && <div className="my-1 h-px bg-line" role="separator" />}
          {danger.map(row)}
        </div>
      )}
    </div>
  );
};
