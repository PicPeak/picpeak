import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, House } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { childFolders, folderAncestry, type FolderNode } from '../../../utils/folderTree';
import { treeKeyDown } from '../../../utils/ariaKeyboard';

interface FolderTreePickerProps {
  folders: FolderNode[];
  /** Selected folder; null = gallery root, undefined = nothing picked yet. */
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  /** Offer the gallery root (top level) as a target. */
  allowRoot?: boolean;
  /** Folders that cannot be picked (a folder's own subtree when moving it, too deep). */
  isDisabled?: (id: number) => boolean;
}

/**
 * Gallery folder picker (issue 1786). Same shape as the external-media
 * picker (ExternalFolderPicker): folders only, children rendered when their
 * parent is expanded, the current selection's ancestors open on mount.
 * Arrow keys move through the rows (utils/ariaKeyboard).
 */
export const FolderTreePicker: React.FC<FolderTreePickerProps> = ({
  folders,
  value,
  onChange,
  allowRoot = false,
  isDisabled,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(folderAncestry(folders, value ?? null).slice(0, -1).map((f) => f.id))
  );

  const setOpen = (id: number, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggle = (id: number) => setOpen(id, !expanded.has(id));

  const rowClass = (selected: boolean, disabled: boolean) =>
    'flex items-center gap-1 py-1 pr-1 rounded ' +
    (selected ? 'bg-accent-dark/10' : disabled ? '' : 'hover:bg-hover');

  const renderLevel = (parentId: number | null, depth: number): React.ReactNode =>
    childFolders(folders, parentId).map((folder) => {
      const hasChildren = childFolders(folders, folder.id).length > 0;
      const open = expanded.has(folder.id);
      const selected = value === folder.id;
      const disabled = !!isDisabled?.(folder.id);
      return (
        <div key={folder.id} role="none">
          <div className={rowClass(selected, disabled)} style={{ paddingLeft: depth * 16 + 4 }}>
            {hasChildren ? (
              <button
                type="button"
                onClick={() => toggle(folder.id)}
                // The arrow keys open and close the row; one Tab stop per row,
                // and the row itself announces whether it is open.
                tabIndex={-1}
                aria-hidden="true"
                className="p-0.5 text-muted hover:text-body"
                aria-label={open ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}
              >
                {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            ) : (
              <span className="w-5" aria-hidden="true" />
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(folder.id)}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasChildren ? open : undefined}
              aria-selected={selected}
              data-tree-item
              data-key={folder.id}
              // Under "Gallery root" when it is shown: indented as its
              // children, so Left goes back up to it.
              data-parent={parentId ?? (allowRoot ? 'root' : '')}
              data-expanded={hasChildren ? String(open) : undefined}
              className={
                'flex items-center gap-1.5 flex-1 min-w-0 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ' +
                (selected ? 'text-heading font-semibold' : 'text-heading')
              }
            >
              {open ? (
                <FolderOpen className="w-4 h-4 flex-shrink-0 text-muted" />
              ) : (
                <Folder className="w-4 h-4 flex-shrink-0 text-muted" />
              )}
              <span className="truncate">{folder.name}</span>
            </button>
          </div>
          {open && renderLevel(folder.id, depth + 1)}
        </div>
      );
    });

  return (
    <div
      role="tree"
      className="max-h-80 overflow-auto border border-line rounded-lg p-2"
      onKeyDown={(e) => treeKeyDown(e, {
        expand: (key) => setOpen(Number(key), true),
        collapse: (key) => setOpen(Number(key), false),
      })}
    >
      {allowRoot && (
        <div className={rowClass(value === null, false)} style={{ paddingLeft: 4 }}>
          <span className="w-5" aria-hidden="true" />
          <button
            type="button"
            onClick={() => onChange(null)}
            role="treeitem"
            aria-level={1}
            aria-selected={value === null}
            data-tree-item
            data-key="root"
            data-parent=""
            className={
              'flex items-center gap-1.5 flex-1 min-w-0 text-left text-sm ' +
              (value === null ? 'text-heading font-semibold' : 'text-heading')
            }
          >
            <House className="w-4 h-4 flex-shrink-0 text-muted" />
            <span className="truncate">{t('photos.folders.galleryRoot', 'Gallery root')}</span>
          </button>
        </div>
      )}
      {renderLevel(null, allowRoot ? 1 : 0)}
      {folders.length === 0 && (
        <p className="px-2 py-1 text-xs italic text-muted">{t('photos.folders.noFolders', 'No folders yet')}</p>
      )}
    </div>
  );
};
