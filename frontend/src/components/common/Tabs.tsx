import React, { useRef } from 'react';
import clsx from 'clsx';

export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** A count next to the label. */
  count?: number;
  /** An amber dot: something in this tab is not saved yet. */
  dirty?: boolean;
  dirtyLabel?: string;
}

interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  'aria-label'?: string;
  className?: string;
}

/**
 * The tab row of an entity page (Overview first, Settings last). Arrow keys
 * move between tabs. The divider is an inset shadow, not a border: it paints
 * under the tabs, so the active underline covers it without hanging past the
 * row, and overflow-y-hidden never clips it (STYLING.md › Layout).
 */
export function Tabs<T extends string>({ items, value, onChange, className, ...rest }: TabsProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const jump = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (!step && jump === null) return;
    e.preventDefault();
    const next = items[jump ?? (index + step + items.length) % items.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div className={clsx('shrink-0 shadow-[inset_0_-1px_0_var(--ui-line)] overflow-x-auto overflow-y-hidden', className)}>
      <div className="flex gap-8" role="tablist" aria-label={rest['aria-label']}>
        {items.map((item, index) => {
          const active = item.id === value;
          return (
            <button
              key={item.id}
              ref={(el) => { refs.current[item.id] = el; }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(item.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={clsx(
                'py-2 px-1 border-b-2 font-medium text-sm flex items-center gap-2 whitespace-nowrap',
                active ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-body hover:border-line-strong',
              )}
            >
              {item.icon && <span className="[&>svg]:w-4 [&>svg]:h-4" aria-hidden="true">{item.icon}</span>}
              <span>{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span className="ml-1 px-2 py-0.5 text-xs font-medium bg-inset text-body rounded-full">{item.count}</span>
              )}
              {item.dirty && (
                <span className="w-2 h-2 rounded-full bg-warning" role="img" aria-label={item.dirtyLabel} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
