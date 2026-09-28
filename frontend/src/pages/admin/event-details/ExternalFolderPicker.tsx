import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderTreeNode } from './FolderTreeNode';

export const ExternalFolderPicker: React.FC<{ value: string; onChange: (p: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();

  // Seed expanded paths so the current selection (and the synthetic root) is visible on mount.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    const set = new Set<string>(['']);
    if (value) {
      const parts = value.split('/').filter(Boolean);
      let acc = '';
      for (const seg of parts) {
        acc = acc ? `${acc}/${seg}` : seg;
        set.add(acc);
      }
    }
    return set;
  });

  const toggleExpand = (p: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <div className="mt-2 border border-line rounded-lg p-2">
      <div className="flex items-center justify-between gap-2 mb-2 px-1">
        <div className="text-xs text-soft truncate">
          {t('common.selected', 'Selected')}: /external-media/{value}
        </div>
        {value && (
          <button
            type="button"
            className="text-xs underline text-body hover:text-heading flex-shrink-0"
            onClick={() => onChange('')}
          >
            {t('events.clearSelection', 'Clear')}
          </button>
        )}
      </div>
      <div className="max-h-80 overflow-auto [color-scheme:light] dark:[color-scheme:dark]">
        <FolderTreeNode
          path=""
          name="/external-media"
          depth={0}
          value={value}
          onChange={onChange}
          expandedPaths={expandedPaths}
          toggleExpand={toggleExpand}
        />
      </div>
    </div>
  );
};
