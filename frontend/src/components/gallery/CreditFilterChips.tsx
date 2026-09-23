import React, { useMemo } from 'react';
import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';
import type { Photo } from '../../types';
import { creditGroups, type CreditGroup } from '../../utils/photoCredits';

interface CreditFilterChipsProps {
  // The photos the counts are taken from — the current scope, like the
  // category chips, so a chip never advertises a count the grid won't show.
  photos: Photo[];
  selectedKey: string | null;
  onChange: (key: string | null) => void;
  // 'row' scrolls horizontally (filter bar); 'list' stacks (sidebar).
  variant?: 'row' | 'list';
  className?: string;
}

/**
 * The "By" filter (#1561): who took or uploaded each photo, with counts.
 * Renders nothing when no photo carries a name.
 */
export const CreditFilterChips: React.FC<CreditFilterChipsProps> = ({
  photos,
  selectedKey,
  onChange,
  variant = 'row',
  className = '',
}) => {
  const { t, i18n } = useTranslation();
  const groups = useMemo(() => creditGroups(photos, i18n.language), [photos, i18n.language]);
  if (groups.length === 0) return null;

  const labelOf = (group: CreditGroup) => {
    if (group.kind === 'guest') return t('gallery.credits.unnamedGuests');
    if (group.kind === 'photographer') return t('gallery.credits.photographer');
    return group.name;
  };

  if (variant === 'list') {
    const itemClass = (active: boolean) => `w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
      active ? 'bg-accent-dark text-white' : 'text-muted-theme hover:bg-black/10'
    }`;
    return (
      <div className={className}>
        <h3 className="gallery-sidebar-section-title text-sm font-semibold text-muted-theme mb-3 flex items-center gap-2">
          <UserRound className="w-4 h-4" aria-hidden="true" />
          {t('gallery.credits.filterLabel')}
        </h3>
        <div className="space-y-1" role="group" aria-label={t('gallery.credits.filterLabel')}>
          <button type="button" className={itemClass(selectedKey === null)} onClick={() => onChange(null)}>
            <span>{t('gallery.credits.everyone')}</span>
            <span className="text-xs opacity-75">{photos.length}</span>
          </button>
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={itemClass(selectedKey === group.key)}
              onClick={() => onChange(selectedKey === group.key ? null : group.key)}
            >
              <span className="truncate text-left">{labelOf(group)}</span>
              <span className="text-xs opacity-75 flex-shrink-0 ml-2">{group.count}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="text-xs md:text-sm text-muted-theme whitespace-nowrap flex items-center gap-1">
        <UserRound className="w-3.5 h-3.5" aria-hidden="true" />
        {t('gallery.credits.filterLabel')}
      </span>
      <div className="overflow-x-auto pb-1 min-w-0">
        <div className="flex items-center gap-2 min-w-max" role="group" aria-label={t('gallery.credits.filterLabel')}>
          <Button
            variant={selectedKey === null ? 'primary' : 'outline'}
            size="sm"
            onClick={() => onChange(null)}
            className="text-xs md:text-sm whitespace-nowrap flex-shrink-0"
          >
            {t('gallery.credits.everyone')} ({photos.length})
          </Button>
          {groups.map((group) => (
            <Button
              key={group.key}
              variant={selectedKey === group.key ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onChange(selectedKey === group.key ? null : group.key)}
              className="text-xs md:text-sm whitespace-nowrap flex-shrink-0"
            >
              {labelOf(group)} ({group.count})
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
};

CreditFilterChips.displayName = 'CreditFilterChips';
