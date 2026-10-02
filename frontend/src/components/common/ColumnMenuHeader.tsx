/**
 * A table column header that opens a small menu of named choices.
 *
 * SortableHeader (invoices / quotes / contracts) toggles one column between
 * ascending and descending on click. That works where the axis is obvious, but
 * it cannot say what a direction *means* — on the events list "Datum ▲" is
 * ambiguous between oldest-first and last-created — and it offers exactly two
 * choices per column, so a column that needs a third (event date vs. creation
 * date) has nowhere to put it. This header spells the options out instead:
 * "Newest first", "Oldest first", "Recently created".
 *
 * The same shape carries a filter (one option per event type), so every column
 * in a header row behaves the same way whether it sorts or narrows.
 *
 * The menu is rendered `position: fixed` against the trigger's viewport rect
 * rather than absolutely inside the `th`. A table in a horizontally scrollable
 * wrapper computes `overflow-y: visible` as `auto`, so an absolutely positioned
 * menu is clipped to the header row — the same reason the row action menu on
 * this page is fixed. It closes on scroll or resize, since a fixed element does
 * not follow the trigger.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Check, Filter } from 'lucide-react';

export interface ColumnMenuOption {
  /** Opaque value handed back to onSelect. */
  value: string;
  label: string;
  /** Draws a divider above this option — groups related choices. */
  separatorBefore?: boolean;
}

/**
 * What the header shows at rest:
 *   'asc' / 'desc'  this column is the active sort, in that direction
 *   'set'           a non-directional choice is applied (a filter)
 *   null            nothing applied; the header shows a faint "has a menu" hint
 */
export type ColumnMenuState = 'asc' | 'desc' | 'set' | null;

interface ColumnMenuHeaderProps {
  label: React.ReactNode;
  options: ColumnMenuOption[];
  /** The applied option's value, or null when none is. */
  value: string | null;
  onSelect: (value: string) => void;
  state?: ColumnMenuState;
  align?: 'left' | 'right';
  /**
   * Renders the header as plain text with no menu. For a column whose options
   * are still loading or failed to load — an empty menu that opens is worse
   * than a header that visibly has nothing to offer yet.
   */
  disabled?: boolean;
  /**
   * Accessible name for the MENU, e.g. "Sort by date". Deliberately not an
   * aria-label on the trigger: that would replace the visible column name in
   * the accessible name, so "click Datum" would match nothing by voice and a
   * screen reader would never read the column out (WCAG 2.5.3).
   */
  menuLabel?: string;
  /**
   * Cell padding and visibility for the `th`. A table with tighter rows or
   * columns that hide at a breakpoint passes its own, e.g.
   * "hidden md:table-cell px-3 py-2".
   */
  className?: string;
}

const MENU_WIDTH = 224; // w-56
const MENU_GAP = 4; // breathing room between trigger and menu
const MENU_EDGE = 8; // smallest gap left against a viewport edge
/** Below this, opening downwards is not worth it — flip above the trigger. */
const MENU_MIN_HEIGHT = 160;
const NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

interface MenuPosition {
  /** Exactly one of top/bottom is set; the other anchors an upward menu. */
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
}

export const ColumnMenuHeader: React.FC<ColumnMenuHeaderProps> = ({
  label, options, value, onSelect, state = null, align = 'left', disabled = false, menuLabel,
  className = 'px-6 py-3',
}) => {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const open = position !== null;

  const close = useCallback((returnFocus = false) => {
    setPosition(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    // role="menu" puts assistive tech into application mode, where Up/Down are
    // the expected way to move between items — Tab alone is not enough there.
    // Escape returns focus to the trigger; a click outside does not, so the
    // page does not yank focus back while the admin is reaching elsewhere.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close(true);
        return;
      }
      if (!NAVIGATION_KEYS.includes(event.key)) return;
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
      );
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % items.length
            : (current <= 0 ? items.length : current) - 1;
      items[next]?.focus();
    };
    // A fixed element does not follow the trigger, so the menu closes when the
    // page moves under it — but NOT when the scrolling happened inside the
    // menu itself. Without that exclusion, arrowing onto an option below the
    // fold scrolls it into view, which is a scroll event, which closed the
    // menu the keyboard was navigating.
    const onReflow = (event: Event) => {
      // `target` is a Document for a page scroll but can be the Window, and
      // Node.contains() THROWS on a non-Node argument rather than returning
      // false — a throw here leaves the menu open forever, which is the bug
      // this guard exists to prevent.
      const target = event.target;
      if (event.type === 'scroll' && target instanceof Node && menuRef.current?.contains(target)) return;
      close();
    };
    // Tab moves focus out of the menu without any of the handlers above
    // firing, which left an open menu behind wherever focus went next.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!next) return;
      if (menuRef.current?.contains(next) || triggerRef.current?.contains(next)) return;
      close();
    };

    // Focus lands on the applied option when there is one, so a reader hears
    // the current choice rather than the top of the list.
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();

    const menu = menuRef.current;
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    menu?.addEventListener('focusout', onFocusOut);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      menu?.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, close]);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Clamped to the viewport so a menu under the rightmost column does not
    // open off-screen (the table scrolls horizontally on narrow screens).
    const left = Math.max(
      MENU_EDGE,
      Math.min(
        align === 'right' ? rect.right - MENU_WIDTH : rect.left,
        window.innerWidth - MENU_WIDTH - MENU_EDGE,
      ),
    );
    // The option list is open-ended — the type filter carries one row per
    // configured event type, including deactivated ones — so the menu is
    // capped to the space it actually has and scrolls within that cap. Without
    // the cap an instance with a few dozen types runs past the bottom of the
    // viewport and its last options cannot be reached at all.
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - MENU_EDGE;
    const spaceAbove = rect.top - MENU_GAP - MENU_EDGE;
    const openUpwards = spaceBelow < MENU_MIN_HEIGHT && spaceAbove > spaceBelow;
    setPosition({
      ...(openUpwards
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
      left,
      maxHeight: Math.max(MENU_MIN_HEIGHT, openUpwards ? spaceAbove : spaceBelow),
    });
  };

  const applied = state !== null;

  return (
    <th className={`${className} ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`group inline-flex items-center gap-1 align-middle text-xs font-medium uppercase tracking-wider transition-colors ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${applied ? 'text-body' : 'text-muted'} ${
          disabled ? 'cursor-default' : 'hover:text-body'
        }`}
      >
        <span>{label}</span>
        {!disabled && (
          <>
            {state === 'asc' && <ChevronUp className="w-3 h-3" aria-hidden="true" />}
            {state === 'desc' && <ChevronDown className="w-3 h-3" aria-hidden="true" />}
            {state === 'set' && <Filter className="w-3 h-3" aria-hidden="true" />}
            {state === null && (
              <ChevronDown className="w-3 h-3 opacity-30 group-hover:opacity-60" aria-hidden="true" />
            )}
          </>
        )}
      </button>

      {open && position && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          className="fixed z-50 w-56 overflow-y-auto rounded-md bg-panel py-1 shadow-lg ring-1 ring-line"
          style={{
            top: position.top !== undefined ? `${position.top}px` : undefined,
            bottom: position.bottom !== undefined ? `${position.bottom}px` : undefined,
            left: `${position.left}px`,
            maxHeight: `${position.maxHeight}px`,
          }}
        >
          {options.map((option) => {
            const isApplied = option.value === value;
            return (
              <React.Fragment key={option.value}>
                {option.separatorBefore && <div className="my-1 border-t border-line" />}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={isApplied}
                  onClick={() => { onSelect(option.value); close(true); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm normal-case tracking-normal text-body hover:bg-hover"
                >
                  <Check
                    className={`w-4 h-4 shrink-0 ${isApplied ? 'opacity-100' : 'opacity-0'}`}
                    aria-hidden="true"
                  />
                  <span>{option.label}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </th>
  );
};
