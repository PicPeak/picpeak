/**
 * Folder tree for the sidebar controls style (issue 1786).
 *
 * A collapsible tree instead of a flat list, since folders now nest. Children
 * render only once their parent is expanded, and the branch leading to the
 * open folder is expanded automatically so the guest always sees where they
 * are. "All photos" sits on top as the view switch's sidebar equivalent.
 * Arrow keys move through the rows (utils/ariaKeyboard).
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen, Home, LayoutGrid } from 'lucide-react';

import { folderKey, type FolderTreeNode, type GalleryViewMode } from './folders';
import { treeKeyDown } from '../../utils/ariaKeyboard';

export interface SidebarFolderTreeProps {
  nodes: FolderTreeNode[];
  /** Ids from the root down to the open folder; empty at root. */
  openPath: Array<number | string>;
  view: GalleryViewMode;
  /** Folder key to open, or null for the gallery root. */
  onOpenFolder: (key: string | null) => void;
  onViewChange: (view: GalleryViewMode) => void;
  /** Photos directly at the root, for the root row's count. */
  rootCount: number;
  /** Every photo, for the "All photos" row's count. */
  totalCount: number;
}

const itemClass = (active: boolean) => `
  gallery-btn w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 min-w-0
  ${active ? 'bg-accent-dark text-accent-fg' : 'hover-surface text-muted-theme'}
`;

export const GallerySidebarFolderTree: React.FC<SidebarFolderTreeProps> = ({
  nodes,
  openPath,
  view,
  onOpenFolder,
  onViewChange,
  rootCount,
  totalCount,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(openPath.map(String)));

  // Opening a folder from the grid (a tile, the breadcrumb, a deep link)
  // expands its branch here too.
  const openPathKey = openPath.map(String).join('/');
  useEffect(() => {
    if (!openPathKey) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      openPathKey.split('/').forEach((id) => next.add(id));
      return next;
    });
  }, [openPathKey]);

  const openId = view === 'folders' && openPath.length > 0 ? String(openPath[openPath.length - 1]) : null;

  const setOpen = (id: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggle = (id: string) => setOpen(id, !expanded.has(id));

  const renderNodes = (list: FolderTreeNode[], depth: number, parent: string): React.ReactNode => (
    <ul
      // Levels come from aria-level on the rows, so the nested lists are plain.
      role={depth === 0 ? 'tree' : 'none'}
      className="space-y-0.5"
      onKeyDown={depth === 0
        ? (e) => treeKeyDown(e, { expand: (key) => setOpen(key, true), collapse: (key) => setOpen(key, false) })
        : undefined}
    >
      {list.map((node) => {
        const id = String(node.category.id);
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(id);
        const isOpen = openId === id;
        const Icon = isOpen ? FolderOpen : Folder;
        return (
          <li key={id} role="none">
            <div className="flex items-center" style={{ paddingLeft: `${depth * 0.75}rem` }}>
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  // The arrow keys open and close the row; one Tab stop per row,
                  // and the row itself announces whether it is open.
                  tabIndex={-1}
                  aria-hidden="true"
                  aria-label={isExpanded
                    ? t('gallery.collapseFolder', 'Collapse {{name}}', { name: node.category.name })
                    : t('gallery.expandFolder', 'Expand {{name}}', { name: node.category.name })}
                  className="shrink-0 p-1 rounded text-muted-theme hover-surface"
                >
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                </button>
              ) : (
                <span className="shrink-0 w-[1.375rem]" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => onOpenFolder(folderKey(node.category))}
                className={itemClass(isOpen)}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={hasChildren ? isExpanded : undefined}
                aria-selected={isOpen}
                data-tree-item
                data-key={id}
                data-parent={parent}
                data-expanded={hasChildren ? String(isExpanded) : undefined}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate flex-1">{node.category.name}</span>
                <span className={`text-sm ${isOpen ? '' : 'text-muted-theme'}`}>{node.count}</span>
              </button>
            </div>
            {hasChildren && isExpanded && renderNodes(node.children, depth + 1, id)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-1">
      <button type="button" onClick={() => onViewChange('all')} className={itemClass(view === 'all')}>
        <LayoutGrid className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="truncate flex-1">{t('gallery.viewAllPhotos', 'All photos')}</span>
        <span className={`text-sm ${view === 'all' ? '' : 'text-muted-theme'}`}>{totalCount}</span>
      </button>
      <button
        type="button"
        onClick={() => onOpenFolder(null)}
        className={itemClass(view === 'folders' && openPath.length === 0)}
      >
        <Home className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="truncate flex-1">{t('gallery.folderRoot', 'Gallery')}</span>
        <span className={`text-sm ${view === 'folders' && openPath.length === 0 ? '' : 'text-muted-theme'}`}>{rootCount}</span>
      </button>
      {renderNodes(nodes, 0, '')}
    </div>
  );
};
