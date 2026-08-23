import React from 'react';
import { useTranslation } from 'react-i18next';
import { COLOR_LABELS, COLOR_LABEL_SWATCHES, type ColorLabel } from '../../services/feedback.service';

interface ColorLabelFilterChipsProps {
  activeColors: ColorLabel[];
  onToggle: (color: ColorLabel) => void;
  /** Per-colour counts for the viewer's own labels. */
  counts?: Partial<Record<ColorLabel, number>>;
  /** Hide colours nobody has used yet. On by default — five permanently
   *  empty swatches are noise in a gallery that isn't using every colour. */
  hideEmpty?: boolean;
  className?: string;
  showLabel?: boolean;
}

/**
 * "Show only the greens" (#1044). Multi-select: each chip toggles its colour,
 * an empty set means no colour filtering.
 */
export const ColorLabelFilterChips: React.FC<ColorLabelFilterChipsProps> = ({
  activeColors,
  onToggle,
  counts = {},
  hideEmpty = true,
  className = '',
  showLabel = true,
}) => {
  const { t } = useTranslation();

  const visible = COLOR_LABELS.filter(color =>
    !hideEmpty || (counts[color] || 0) > 0 || activeColors.includes(color)
  );
  if (visible.length === 0) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showLabel && (
        <span className="text-sm text-muted-theme whitespace-nowrap">
          {t('gallery.colorFilter', 'Color')}
        </span>
      )}
      <div className="flex items-center gap-1 flex-wrap">
        {visible.map((color) => {
          const isActive = activeColors.includes(color);
          const swatch = COLOR_LABEL_SWATCHES[color];
          const count = counts[color] || 0;
          const name = t(`feedback.colorLabels.${color}`, color);
          return (
            <button
              key={color}
              type="button"
              onClick={() => onToggle(color)}
              aria-pressed={isActive}
              // Colour is the only thing distinguishing these chips, so the
              // name has to carry it for screen readers and colour-blind
              // viewers; the count is part of the visible label.
              aria-label={t('gallery.filterByColor', 'Show only {{color}}', { color: name })}
              title={`${name}${count > 0 ? ` (${count})` : ''}`}
              className={`flex items-center gap-1.5 pl-1.5 pr-2 h-8 rounded-full border text-xs transition-all ${
                isActive
                  ? 'border-current ring-2 ring-offset-1 ring-current text-theme'
                  : 'border-black/15 text-muted-theme hover:border-current'
              }`}
              style={isActive ? { color: swatch.ring } : undefined}
            >
              <span
                className="w-4 h-4 rounded-full border shrink-0"
                style={{ backgroundColor: swatch.fill, borderColor: swatch.ring }}
                aria-hidden="true"
              />
              {count > 0 && <span className="font-medium">{count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};
