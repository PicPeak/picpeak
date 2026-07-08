import React from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { externalMediaService } from '../../../services/externalMedia.service';

export const FolderTreeNode: React.FC<{
  path: string;
  name: string;
  depth: number;
  value: string;
  onChange: (p: string) => void;
  expandedPaths: Set<string>;
  toggleExpand: (p: string) => void;
}> = ({ path, name, depth, value, onChange, expandedPaths, toggleExpand }) => {
  const { t } = useTranslation();
  const isExpanded = expandedPaths.has(path);
  const isSelected = value === path;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['external-folder-children', path],
    queryFn: () => externalMediaService.list(path),
    enabled: isExpanded,
    staleTime: 30_000
  });

  const dirs = (data?.entries || []).filter(e => e.type === 'dir');
  const showEmpty = isExpanded && !isLoading && !isError && dirs.length === 0;
  const indentStyle = { paddingLeft: depth * 16 + 4 };
  const childIndentStyle = { paddingLeft: (depth + 1) * 16 + 4 };
  const rowClass =
    'flex items-center gap-1 py-1 pr-1 rounded ' +
    (isSelected
      ? 'bg-accent-dark/15'
      : 'hover:bg-neutral-50 dark:hover:bg-neutral-700');

  return (
    <div>
      <div className={rowClass} style={indentStyle}>
        <button
          type="button"
          onClick={() => toggleExpand(path)}
          className="p-0.5 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          aria-label={isExpanded ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}
        >
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => onChange(path)}
          className={
            'flex items-center gap-1.5 flex-1 min-w-0 text-left text-sm ' +
            (isSelected
              ? 'text-accent-dark font-medium'
              : 'text-neutral-900 dark:text-neutral-100')
          }
        >
          {isExpanded ? (
            <FolderOpen className="w-4 h-4 flex-shrink-0 text-accent" />
          ) : (
            <Folder className="w-4 h-4 flex-shrink-0 text-neutral-500" />
          )}
          <span className="truncate">{name}</span>
        </button>
      </div>
      {isExpanded && (
        <div>
          {isLoading && (
            <div
              className="flex items-center gap-2 py-1 text-xs text-neutral-500 dark:text-neutral-400"
              style={childIndentStyle}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{t('common.loading', 'Loading...')}</span>
            </div>
          )}
          {isError && (
            <div
              className="py-1 text-xs text-red-600 dark:text-red-400"
              style={childIndentStyle}
            >
              {t('errors.somethingWentWrong', 'Something went wrong')}
            </div>
          )}
          {showEmpty && (
            <div
              className="py-1 text-xs italic text-neutral-500 dark:text-neutral-400"
              style={childIndentStyle}
            >
              {t('events.externalFolderEmpty', 'No subfolders')}
            </div>
          )}
          {dirs.map(d => {
            const childPath = path ? `${path}/${d.name}` : d.name;
            return (
              <FolderTreeNode
                key={childPath}
                path={childPath}
                name={d.name}
                depth={depth + 1}
                value={value}
                onChange={onChange}
                expandedPaths={expandedPaths}
                toggleExpand={toggleExpand}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};
