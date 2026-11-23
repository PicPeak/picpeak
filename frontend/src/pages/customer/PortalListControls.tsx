/**
 * Shared controls for the customer portal's document lists (invoices,
 * quotes, contracts, documents): the filter + sort bar, its sort
 * comparator, and the "403 means feature disabled, otherwise error"
 * block.
 */
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../components/common';

export type SortKey = 'newest' | 'oldest' | 'price_desc' | 'price_asc';

export interface PortalOption<V extends string> { value: V; key: string; fallback: string }

export const SORT_OPTIONS: PortalOption<SortKey>[] = [
  { value: 'newest',     key: 'customer.sort.newest',    fallback: 'Newest first' },
  { value: 'oldest',     key: 'customer.sort.oldest',    fallback: 'Oldest first' },
  { value: 'price_desc', key: 'customer.sort.priceDesc', fallback: 'Price (high to low)' },
  { value: 'price_asc',  key: 'customer.sort.priceAsc',  fallback: 'Price (low to high)' },
];

/** Returns a sorted copy of `rows`; price sorts read `totalAmountMinor`. */
export function sortPortalRows<T extends { issueDate: string; totalAmountMinor?: number }>(
  rows: T[],
  sort: SortKey,
): T[] {
  return [...rows].sort((a, b) => {
    switch (sort) {
    case 'oldest':
      return new Date(a.issueDate).getTime() - new Date(b.issueDate).getTime();
    case 'price_desc':
      return Number(b.totalAmountMinor || 0) - Number(a.totalAmountMinor || 0);
    case 'price_asc':
      return Number(a.totalAmountMinor || 0) - Number(b.totalAmountMinor || 0);
    case 'newest':
    default:
      return new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime();
    }
  });
}

interface FilterSortBarProps<S extends string, K extends SortKey> {
  sort: K;
  onSortChange: (v: K) => void;
  /** Defaults to all four sorts; contracts only offer newest / oldest. */
  sortOptions?: PortalOption<K>[];
  statusFilter: S;
  onStatusChange: (v: S) => void;
  statusOptions: PortalOption<S>[];
  totalRowCount: number;
  visibleRowCount: number;
}
export function FilterSortBar<S extends string, K extends SortKey = SortKey>({
  sort, onSortChange, sortOptions = SORT_OPTIONS as PortalOption<K>[],
  statusFilter, onStatusChange, statusOptions,
  totalRowCount, visibleRowCount,
}: FilterSortBarProps<S, K>) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-theme uppercase tracking-wider">
          {t('customer.filter.label', 'Filter')}
        </label>
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as S)}
          className="input-themed h-9 w-auto"
        >
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>{t(o.key, o.fallback)}</option>
          ))}
        </select>
        <label className="text-xs text-muted-theme uppercase tracking-wider ml-2">
          {t('customer.sort.label', 'Sort')}
        </label>
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as K)}
          className="input-themed h-9 w-auto"
        >
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>{t(o.key, o.fallback)}</option>
          ))}
        </select>
      </div>
      <div className="text-xs text-muted-theme">
        {visibleRowCount === totalRowCount
          ? t('customer.filter.countAll', '{{count}} total', { count: totalRowCount })
          : t('customer.filter.countFiltered', '{{visible}} of {{total}}', { visible: visibleRowCount, total: totalRowCount })}
      </div>
    </div>
  );
}

interface PortalLoadErrorProps {
  error: unknown;
  title: string;
  /** Shown on a 403 (feature disabled for this account). */
  disabledText: string;
  loadErrorTitle: string;
  onRetry: () => void;
  retrying: boolean;
  /** Show the page title above the retry block too, not only on a 403. */
  alwaysShowTitle?: boolean;
}
export function PortalLoadError({
  error, title, disabledText, loadErrorTitle, onRetry, retrying, alwaysShowTitle = false,
}: PortalLoadErrorProps) {
  const disabled = (error as { response?: { status?: number } } | null)?.response?.status === 403;
  return (
    <div className="container py-8">
      {(disabled || alwaysShowTitle) && (
        <h1 className="text-2xl font-bold text-theme mb-2">{title}</h1>
      )}
      {disabled ? (
        <p className="text-muted-theme">{disabledText}</p>
      ) : (
        <ErrorState title={loadErrorTitle} onRetry={onRetry} retrying={retrying} />
      )}
    </div>
  );
}
