import React from 'react';
import { useTranslation } from 'react-i18next';
import { useFavoriteListsOptional } from '../../contexts/FavoriteListsContext';

const MANAGE = '__manage';

interface FavoriteListSwitcherProps {
  /** 'toolbar': the lightbox's black bar; 'panel': on a themed surface. */
  variant?: 'panel' | 'toolbar';
  className?: string;
}

/**
 * Which favourite list the bookmark saves to (issue 2303), and the way into
 * the dialog that creates, renames and deletes lists. A native select: it is
 * one control on a phone and never wider than its container. Renders nothing
 * while the gallery has lists off.
 */
export const FavoriteListSwitcher: React.FC<FavoriteListSwitcherProps> = ({ variant = 'panel', className = '' }) => {
  const { t } = useTranslation();
  const favoriteLists = useFavoriteListsOptional();
  if (!favoriteLists) return null;

  const { lists, defaultCount, activeListId, setActiveListId, openManager } = favoriteLists;
  const label = t('gallery.favoriteLists.saveTo', 'Save to list');

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const { value } = event.target;
    if (value === MANAGE) {
      openManager();
      return;
    }
    setActiveListId(value === '' ? null : Number(value));
  };

  const style = variant === 'toolbar'
    ? 'bg-white/10 hover:bg-white/20 text-white border-0 rounded-full px-2 py-1 text-xs max-w-[7.5rem] sm:max-w-[10rem] [&>option]:text-black'
    : 'input-themed rounded-lg px-2 py-1.5 text-sm max-w-full';

  const select = (
    <select
      value={activeListId === null ? '' : String(activeListId)}
      onChange={handleChange}
      aria-label={label}
      title={label}
      className={`min-w-0 truncate cursor-pointer ${style} ${variant === 'toolbar' ? className : ''}`}
    >
      <option value="">{t('gallery.favoriteLists.defaultList', 'My favorites')} ({defaultCount})</option>
      {lists.map((list) => (
        <option key={list.id} value={String(list.id)}>{list.name} ({list.count})</option>
      ))}
      <option value={MANAGE}>{t('gallery.favoriteLists.manage', 'Manage lists…')}</option>
    </select>
  );
  // The lightbox bar has no room for a caption; everywhere else the select
  // also decides what "Saved" shows, which a bare select does not say.
  if (variant === 'toolbar') return select;
  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <span className="text-xs text-muted-theme">{label}</span>
      {select}
    </div>
  );
};
