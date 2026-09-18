/**
 * Customer group chips and the overview's group filter (#1443).
 *
 * The colour is a dot beside the name, never the background of the text and
 * never the only thing that carries the meaning: the group is readable at any
 * contrast, in either theme, and to a screen reader. That also means an admin
 * can pick any colour without making a chip unreadable.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, X } from 'lucide-react';
import type { CustomerGroup } from '../../services/customerAdmin.service';

const dot = (color: string) => ({ backgroundColor: color });

interface CustomerGroupChipProps {
  group: CustomerGroup;
  onRemove?: () => void;
  className?: string;
}

/** One group, as it shows on a customer row or on the detail page. */
export const CustomerGroupChip: React.FC<CustomerGroupChipProps> = ({ group, onRemove, className = '' }) => {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${className}`}
      title={group.description || group.name}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={dot(group.color)} aria-hidden="true" />
      <span className="truncate">{group.name}</span>
      {group.isArchived && (
        <Archive
          className="h-3 w-3 shrink-0 text-neutral-400"
          aria-label={t('customers.groups.archived', 'Archived')}
        />
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-full p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700"
          aria-label={t('customers.groups.removeFrom', 'Remove from {{name}}', { name: group.name })}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
};

interface CustomerGroupChipListProps {
  groups?: CustomerGroup[];
  /** Beyond this many, the rest collapse into "+n". Keeps a row readable. */
  max?: number;
}

/** The groups on one customer, wrapping rather than stretching the row. */
export const CustomerGroupChipList: React.FC<CustomerGroupChipListProps> = ({ groups, max = 3 }) => {
  const { t } = useTranslation();
  if (!groups || groups.length === 0) {
    return <span className="text-xs text-neutral-400">{t('customers.groups.none', '—')}</span>;
  }
  const shown = groups.slice(0, max);
  const rest = groups.slice(max);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((group) => <CustomerGroupChip key={group.id} group={group} />)}
      {rest.length > 0 && (
        <span
          className="text-xs text-neutral-500 dark:text-neutral-400"
          title={rest.map((group) => group.name).join(', ')}
        >
          {t('customers.groups.more', '+{{count}}', { count: rest.length })}
        </span>
      )}
    </span>
  );
};

interface CustomerGroupFilterProps {
  groups: CustomerGroup[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  onClear: () => void;
}

/**
 * Multi-select filter for the overview. Nothing selected means every
 * customer, which is what the page opens with.
 */
export const CustomerGroupFilter: React.FC<CustomerGroupFilterProps> = ({
  groups, selectedIds, onToggle, onClear,
}) => {
  const { t } = useTranslation();
  if (groups.length === 0) return null;
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
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
              active
                ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800'
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={dot(group.color)} aria-hidden="true" />
            {group.name}
            {group.memberCount !== undefined && (
              <span className={active ? 'opacity-70' : 'text-neutral-400'}>{group.memberCount}</span>
            )}
          </button>
        );
      })}
      {selectedIds.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-neutral-500 underline hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <X className="h-3 w-3" />
          {t('customers.groups.clearFilter', 'Clear')}
        </button>
      )}
    </div>
  );
};
