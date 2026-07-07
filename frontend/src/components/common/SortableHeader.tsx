/**
 * Finder-style sortable table header.
 *
 * The admin list pages (invoices / quotes / contracts) drive sorting
 * through a single server-side `sort` enum (e.g. 'customer_asc'). This
 * component + the `useColumnSort` hook map that flat enum onto clickable
 * column headers: clicking a column applies its ascending/descending
 * variant, clicking the active column again flips direction. The active
 * column shows a filled chevron; inactive sortable columns show a faint
 * up/down hint so it's discoverable that the header is clickable.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

/** Maps one logical column to its two server-side sort enum values. */
export interface SortPair {
  asc: string;
  desc: string;
  /** Direction applied when this column is first clicked. Defaults to 'asc'. */
  defaultDir?: SortDir;
}

export type SortColumnMap = Record<string, SortPair>;

/**
 * Holds the flat `sort` enum as the single source of truth and exposes
 * the active column + a toggle that flips direction on re-click. Returns
 * `sort` to feed straight into the list query and `setSort` for any
 * legacy callers that still set the enum directly.
 */
export function useColumnSort<T extends string>(columns: SortColumnMap, initialSort: T) {
  const [sort, setSort] = useState<T>(initialSort);

  const active = useMemo(() => {
    for (const [key, pair] of Object.entries(columns)) {
      if (pair.asc === sort) return { key, dir: 'asc' as SortDir };
      if (pair.desc === sort) return { key, dir: 'desc' as SortDir };
    }
    return { key: null as string | null, dir: 'asc' as SortDir };
  }, [columns, sort]);

  const toggle = useCallback((key: string) => {
    const pair = columns[key];
    if (!pair) return;
    setSort((prev) => {
      if (prev === pair.asc) return pair.desc as T;
      if (prev === pair.desc) return pair.asc as T;
      return (pair.defaultDir === 'desc' ? pair.desc : pair.asc) as T;
    });
  }, [columns]);

  return { sort, setSort, activeKey: active.key, activeDir: active.dir, toggle };
}

interface SortableHeaderProps {
  label: React.ReactNode;
  columnKey: string;
  activeKey: string | null;
  activeDir: SortDir;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
}

export const SortableHeader: React.FC<SortableHeaderProps> = ({
  label, columnKey, activeKey, activeDir, onSort, align = 'left',
}) => {
  const active = activeKey === columnKey;
  return (
    <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className={`group inline-flex items-center gap-1 font-medium transition-colors hover:text-theme ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${active ? 'text-theme' : ''}`}
      >
        <span>{label}</span>
        {active ? (
          activeDir === 'asc'
            ? <ChevronUp className="w-3 h-3" />
            : <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60" />
        )}
      </button>
    </th>
  );
};
