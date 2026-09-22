/**
 * Customer group chips and the overview's group filter (#1443).
 *
 * The colour is a dot beside the name, never the background of the text and
 * never the only thing that carries the meaning: the group is readable at any
 * contrast, in either theme, and to a screen reader. That also means an admin
 * can pick any colour without making a chip unreadable.
 */
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, X } from 'lucide-react';
import type { CustomerGroup, CustomerGroupMatch } from '../../services/customerAdmin.service';

/**
 * The colour dot. The 1px ring contrasts with both themes' surfaces, so a
 * colour close to the background (white in light mode, near-black in dark)
 * still shows as a dot instead of vanishing.
 */
export const GroupDot: React.FC<{ color: string; className?: string }> = ({ color, className = 'h-2 w-2' }) => (
  <span
    className={`${className} shrink-0 rounded-full ring-1 ring-black/15 dark:ring-white/25`}
    style={{ backgroundColor: color }}
    aria-hidden="true"
  />
);

interface CustomerGroupChipProps {
  group: CustomerGroup;
  className?: string;
}

/** One group, as it shows on a customer row or on the detail page. */
export const CustomerGroupChip: React.FC<CustomerGroupChipProps> = ({ group, className = '' }) => {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${className}`}
      title={group.description || group.name}
    >
      <GroupDot color={group.color} />
      <span className="truncate">{group.name}</span>
      {group.isArchived && (
        <Archive
          className="h-3 w-3 shrink-0 text-neutral-400"
          aria-label={t('customers.groups.archived', 'Archived')}
        />
      )}
    </span>
  );
};

interface CustomerGroupChipListProps {
  groups?: CustomerGroup[];
  /** Beyond this many, the rest collapse into "+n". Keeps a row readable. */
  max?: number;
  /**
   * False where the list sits inside another control (a picker's option
   * button): the "+n" is then plain text with the names as a tooltip, since
   * a button can't hold a button.
   */
  expandable?: boolean;
}

/**
 * The groups on one customer, wrapping rather than stretching the row.
 * Beyond `max`, a "+n" button reveals the rest in place — reachable by
 * keyboard, and named for a screen reader — and hides them again.
 */
export const CustomerGroupChipList: React.FC<CustomerGroupChipListProps> = ({ groups, max = 3, expandable = true }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const restId = useId();
  if (!groups || groups.length === 0) {
    return <span className="text-xs text-neutral-400">{t('customers.groups.none', '—')}</span>;
  }
  const shown = groups.slice(0, max);
  const rest = groups.slice(max);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((group) => <CustomerGroupChip key={group.id} group={group} />)}
      {rest.length > 0 && !expandable && (
        <span className="text-xs text-neutral-500 dark:text-neutral-400" title={rest.map((group) => group.name).join(', ')}>
          {t('customers.groups.more', '+{{count}}', { count: rest.length })}
        </span>
      )}
      {rest.length > 0 && expandable && (
        <>
          {/* `contents` keeps the chips in the parent's wrapping row; the
              region is empty while collapsed, so nothing needs hiding. */}
          <span id={restId} className="contents">
            {expanded && rest.map((group) => <CustomerGroupChip key={group.id} group={group} />)}
          </span>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={restId}
            aria-label={expanded
              ? t('customers.groups.lessLabel', 'Show fewer groups')
              : t('customers.groups.moreLabel', {
                count: rest.length,
                defaultValue_one: 'Show {{count}} more group',
                defaultValue_other: 'Show {{count}} more groups',
              })}
            className="rounded px-1 text-xs text-neutral-500 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:text-neutral-400"
          >
            {expanded ? t('customers.groups.less', 'Less') : t('customers.groups.more', '+{{count}}', { count: rest.length })}
          </button>
        </>
      )}
    </span>
  );
};

interface CustomerGroupFilterProps {
  groups: CustomerGroup[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  /** Customers in no group. Exclusive with the group pills. */
  ungrouped: boolean;
  ungroupedCount?: number;
  onToggleUngrouped: () => void;
  match: CustomerGroupMatch;
  onMatchChange: (match: CustomerGroupMatch) => void;
  /** Any filter or search is set, so there is something to clear. */
  showClear: boolean;
  onClear: () => void;
}

const pillClass = (active: boolean) => `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
  active
    ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
    : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800'
}`;

const ClearFilters: React.FC<{ onClear: () => void }> = ({ onClear }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClear}
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-neutral-500 underline hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
    >
      <X className="h-3 w-3" />
      {t('customers.groups.clearFilter', 'Clear')}
    </button>
  );
};

/**
 * Multi-select filter for the overview. Nothing selected means every
 * customer, which is what the page opens with. With two or more groups the
 * admin chooses whether a customer has to be in any of them or in all.
 */
export const CustomerGroupFilter: React.FC<CustomerGroupFilterProps> = ({
  groups, selectedIds, onToggle, ungrouped, ungroupedCount, onToggleUngrouped,
  match, onMatchChange, showClear, onClear,
}) => {
  const { t } = useTranslation();
  if (groups.length === 0) {
    return showClear ? <ClearFilters onClear={onClear} /> : null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('customers.groups.filterLabel', 'Filter by group')}>
      <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
        {t('customers.groups.filterLabel', 'Filter by group')}
      </span>
      {groups.map((group) => {
        const active = selectedIds.includes(group.id);
        return (
          <button
            key={group.id}
            type="button"
            onClick={() => onToggle(group.id)}
            aria-pressed={active}
            className={pillClass(active)}
          >
            <GroupDot color={group.color} />
            {group.name}
            {group.memberCount !== undefined && (
              <span className={active ? 'opacity-70' : 'text-neutral-400'}>{group.memberCount}</span>
            )}
          </button>
        );
      })}
      <button type="button" onClick={onToggleUngrouped} aria-pressed={ungrouped} className={pillClass(ungrouped)}>
        {t('customers.groups.ungrouped', 'Ungrouped')}
        {ungroupedCount !== undefined && (
          <span className={ungrouped ? 'opacity-70' : 'text-neutral-400'}>{ungroupedCount}</span>
        )}
      </button>
      {selectedIds.length >= 2 && (
        <span
          className="inline-flex overflow-hidden rounded-full border border-neutral-200 text-xs dark:border-neutral-700"
          role="group"
          aria-label={t('customers.groups.matchLabel', 'Customers in')}
        >
          {(['any', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={match === value}
              onClick={() => onMatchChange(value)}
              className={`px-2.5 py-1 ${
                match === value
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'bg-white text-neutral-700 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800'
              }`}
            >
              {value === 'any'
                ? t('customers.groups.matchAny', 'Any of them')
                : t('customers.groups.matchAll', 'All of them')}
            </button>
          ))}
        </span>
      )}
      {showClear && <ClearFilters onClear={onClear} />}
    </div>
  );
};
