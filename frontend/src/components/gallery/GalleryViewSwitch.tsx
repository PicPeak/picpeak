/**
 * "Folders | All photos" switch (issue 1786). Only rendered for a gallery that
 * has folders: "All photos" turns containment off and lists everything in one
 * grid, which is the view issue 1786 asks for next to the folder navigation.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, LayoutGrid } from 'lucide-react';

import type { GalleryViewMode } from './folders';

interface GalleryViewSwitchProps {
  view: GalleryViewMode;
  onChange: (view: GalleryViewMode) => void;
  className?: string;
}

export const GalleryViewSwitch: React.FC<GalleryViewSwitchProps> = ({ view, onChange, className = '' }) => {
  const { t } = useTranslation();

  const options: Array<{ value: GalleryViewMode; label: string; Icon: typeof Folder }> = [
    { value: 'folders', label: t('gallery.folders', 'Folders'), Icon: Folder },
    { value: 'all', label: t('gallery.viewAllPhotos', 'All photos'), Icon: LayoutGrid },
  ];

  return (
    <div
      role="group"
      aria-label={t('gallery.viewSwitch', 'Show photos by')}
      className={`inline-flex items-center gap-1 p-1 rounded-lg border border-border-token ${className}`}
      style={{ backgroundColor: 'var(--color-background)' }}
    >
      {options.map(({ value, label, Icon }) => {
        const active = view === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => { if (!active) onChange(value); }}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors focus:outline-none focus:ring-2 focus:ring-accent ${
              active ? 'bg-surface shadow-sm font-medium' : 'text-muted-theme hover:opacity-80'
            }`}
            style={active ? { color: 'var(--color-text)' } : undefined}
          >
            <Icon className="w-4 h-4" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
};
