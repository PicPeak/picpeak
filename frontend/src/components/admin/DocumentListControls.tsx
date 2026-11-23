/**
 * Shared pieces of the admin document lists (quotes, contracts,
 * invoices): the filter/sort/page state, the search box, the status
 * chip row and the Previous/Next footer.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Button, useColumnSort, type SortColumnMap } from '../common';

/** Search, status chips, column sort and page; every filter change returns to page 1. */
export function useDocumentListState<S extends string, K extends string>(columns: SortColumnMap, initialSort: K) {
  const [search, setSearchValue] = useState('');
  const [statusFilter, setStatusFilter] = useState<S[]>([]);
  const { sort, activeKey, activeDir, toggle } = useColumnSort<K>(columns, initialSort);
  const [page, setPage] = useState(1);

  const onSort = (key: string) => { toggle(key); setPage(1); };
  const setSearch = (value: string) => { setSearchValue(value); setPage(1); };
  const toggleStatus = (s: S) => {
    setStatusFilter((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
    setPage(1);
  };

  return { search, setSearch, statusFilter, toggleStatus, sort, activeKey, activeDir, onSort, page, setPage };
}

/** The search row; `children` are extra controls after the search box. */
export const ListSearch: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  children?: React.ReactNode;
}> = ({ value, onChange, placeholder, children }) => (
  <div className="flex flex-wrap items-center gap-3">
    <div className="relative flex-1 min-w-[200px]">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
      <input
        type="text"
        placeholder={placeholder}
        className="w-full pl-9 pr-3 py-2 rounded-md border border-line-strong bg-panel text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
    {children}
  </div>
);

/** The status filter chips; `labelPrefix` is the i18n namespace, e.g. `quotes.status`. */
export function StatusChips<S extends string>({ statuses, active, onToggle, labelPrefix }: {
  statuses: S[];
  active: S[];
  onToggle: (s: S) => void;
  labelPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 flex flex-wrap gap-1">
      {statuses.map((s) => (
        <button key={s} type="button" onClick={() => onToggle(s)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
            active.includes(s)
              ? 'bg-accent-dark text-white border-accent-dark'
              : 'bg-panel text-body border-line-strong'
          }`}
        >{t(`${labelPrefix}.${s}`, s)}</button>
      ))}
    </div>
  );
}

/** Previous/Next footer under a list table; renders nothing for a single page. */
export const Pager: React.FC<{
  page: number;
  totalPages: number;
  /** The page's state setter: each click steps from the latest page, so
   *  two quick clicks move two pages. */
  onPageChange: React.Dispatch<React.SetStateAction<number>>;
  /** The "Page x of y · n items" text. */
  label: React.ReactNode;
}> = ({ page, totalPages, onPageChange, label }) => {
  const { t } = useTranslation();
  if (totalPages <= 1) return null;
  return (
    <div className="flex justify-between items-center px-3 py-2 border-t border-line text-sm">
      <span className="text-muted">{label}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange((p) => Math.max(1, p - 1))}>
          {t('common.previous', 'Previous')}
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange((p) => Math.min(totalPages, p + 1))}>
          {t('common.next', 'Next')}
        </Button>
      </div>
    </div>
  );
};
