/**
 * Folder breadcrumb for the guest gallery (issue 1786): home › Saturday ›
 * Activity B. Every level but the last navigates; on a phone the trail
 * scrolls sideways instead of wrapping, and a back button steps up one level.
 *
 * Themed through the gallery `--color-*` variables like the rest of the guest
 * view — never admin `dark:` classes.
 */
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Home } from 'lucide-react';

import type { PhotoCategory } from '../../types';
import { folderKey } from './folders';

interface GalleryBreadcrumbProps {
  /** Root-most folder first, the open folder last; empty at the root. */
  trail: PhotoCategory[];
  /** Folder key to open, or null for the gallery root. */
  onNavigate: (key: string | null) => void;
  className?: string;
}

export const GalleryBreadcrumb: React.FC<GalleryBreadcrumbProps> = ({ trail, onNavigate, className = '' }) => {
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement | null>(null);

  // Keep the current folder in sight: on a narrow screen a deep trail
  // overflows to the right, which is exactly where the open folder sits.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollLeft = list.scrollWidth;
  }, [trail]);

  const parent = trail.length > 1 ? trail[trail.length - 2] : null;
  const rootLabel = t('gallery.folderRoot', 'Gallery');

  return (
    <nav aria-label={t('gallery.folderPath', 'Folder path')} className={`flex items-center gap-2 min-w-0 ${className}`}>
      {trail.length > 0 && (
        <button
          type="button"
          onClick={() => onNavigate(parent ? folderKey(parent) : null)}
          aria-label={t('gallery.folderUp', 'Back to {{name}}', { name: parent ? parent.name : rootLabel })}
          className="sm:hidden shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border-token bg-surface focus:outline-none focus:ring-2 focus:ring-accent"
          style={{ color: 'var(--color-text)' }}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      <ol
        ref={listRef}
        className="flex items-center gap-1 min-w-0 overflow-x-auto whitespace-nowrap text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <li className="shrink-0">
          {trail.length === 0 ? (
            <span
              className="inline-flex items-center gap-1.5 font-medium"
              style={{ color: 'var(--color-text)' }}
              aria-current="page"
            >
              <Home className="w-4 h-4 text-muted-theme" aria-hidden="true" />
              {rootLabel}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate(null)}
              className="inline-flex items-center gap-1.5 text-muted-theme hover:underline focus:outline-none focus:ring-2 focus:ring-accent rounded"
              aria-label={rootLabel}
            >
              <Home className="w-4 h-4" aria-hidden="true" />
              {/* The icon alone carries "home" on a phone, where width is
                  better spent on the folder names. */}
              <span className="hidden sm:inline">{rootLabel}</span>
            </button>
          )}
        </li>
        {trail.map((folder, index) => {
          const isCurrent = index === trail.length - 1;
          return (
            <li key={folder.id} className="shrink-0 inline-flex items-center gap-1">
              <ChevronRight className="w-3.5 h-3.5 text-muted-theme" aria-hidden="true" />
              {isCurrent ? (
                <span className="font-medium" style={{ color: 'var(--color-text)' }} aria-current="page">
                  {folder.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(folderKey(folder))}
                  className="text-muted-theme hover:underline focus:outline-none focus:ring-2 focus:ring-accent rounded"
                >
                  {folder.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
