import React from 'react';
import { Tag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';
import type { Photo } from '../../types';

export interface TagChip {
  key: string;
  count: number;
}

/**
 * The chips to offer for a scope (issue 1733): the gallery's tags in the
 * server's order (most used first), counted over the photos in scope so a
 * chip never advertises a count the grid won't show. A tag with no photo in
 * scope is dropped, unless it is selected: its chip is the way to clear it.
 * That holds for a selected tag the gallery no longer lists at all, too (a
 * refresh after its last photo was deleted or re-tagged): it stays, last.
 */
export function tagChipsFor(
  galleryTags: TagChip[] | undefined,
  scopedPhotos: Photo[],
  selectedKeys: string[],
): TagChip[] {
  const counts = new Map<string, number>();
  for (const photo of scopedPhotos) {
    for (const key of photo.tag_keys || []) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const listed = (galleryTags || []).map(({ key }) => key);
  const gone = selectedKeys.filter((key) => !listed.includes(key));
  return [...listed, ...gone]
    .map((key) => ({ key, count: counts.get(key) || 0 }))
    .filter((chip) => chip.count > 0 || selectedKeys.includes(chip.key));
}

interface TagFilterChipsProps {
  tags: TagChip[];
  selectedKeys: string[];
  onToggle: (key: string) => void;
  // 'row' scrolls horizontally (filter bar); 'list' stacks (sidebar).
  variant?: 'row' | 'list';
  className?: string;
}

/**
 * Scene-tag filter (issue 1733). Multi-select, and several tags widen the
 * result: a photo passes when it carries ANY selected tag, which the hint
 * under the chips says as soon as a second one is picked. Renders nothing
 * when the scope has no tags.
 */
export const TagFilterChips: React.FC<TagFilterChipsProps> = ({
  tags,
  selectedKeys,
  onToggle,
  variant = 'row',
  className = '',
}) => {
  const { t } = useTranslation();
  if (tags.length === 0) return null;

  // An unknown key (a newer sidecar vocabulary than this build knows) still
  // gets a readable label.
  const labelOf = (key: string) =>
    t(`gallery.tags.names.${key}`, { defaultValue: key.replace(/_/g, ' ') }) as string;
  const hint = selectedKeys.length > 1 ? (
    <p className="text-xs text-muted-theme mt-1">{t('gallery.tags.matchAny')}</p>
  ) : null;

  if (variant === 'list') {
    const itemClass = (active: boolean) => `w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
      active ? 'bg-accent-dark text-accent-fg' : 'text-muted-theme hover-surface'
    }`;
    return (
      <div className={className}>
        <h3 className="gallery-sidebar-section-title text-sm font-semibold text-muted-theme mb-3 flex items-center gap-2">
          <Tag className="w-4 h-4" aria-hidden="true" />
          {t('gallery.tags.filterLabel')}
        </h3>
        <div className="space-y-1" role="group" aria-label={t('gallery.tags.filterLabel')}>
          {tags.map((tag) => {
            const active = selectedKeys.includes(tag.key);
            return (
              <button
                key={tag.key}
                type="button"
                aria-pressed={active}
                className={itemClass(active)}
                onClick={() => onToggle(tag.key)}
              >
                <span className="truncate text-left">{labelOf(tag.key)}</span>
                <span className="text-xs opacity-75 flex-shrink-0 ml-2">{tag.count}</span>
              </button>
            );
          })}
        </div>
        {hint}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <span className="text-xs md:text-sm text-muted-theme whitespace-nowrap flex items-center gap-1">
          <Tag className="w-3.5 h-3.5" aria-hidden="true" />
          {t('gallery.tags.filterLabel')}
        </span>
        <div className="overflow-x-auto pb-1 min-w-0">
          <div className="flex items-center gap-2 min-w-max" role="group" aria-label={t('gallery.tags.filterLabel')}>
            {tags.map((tag) => {
              const active = selectedKeys.includes(tag.key);
              return (
                <Button
                  key={tag.key}
                  variant={active ? 'primary' : 'outline'}
                  size="sm"
                  aria-pressed={active}
                  onClick={() => onToggle(tag.key)}
                  className="text-xs md:text-sm whitespace-nowrap flex-shrink-0"
                >
                  {labelOf(tag.key)} ({tag.count})
                </Button>
              );
            })}
          </div>
        </div>
      </div>
      {hint}
    </div>
  );
};

TagFilterChips.displayName = 'TagFilterChips';
